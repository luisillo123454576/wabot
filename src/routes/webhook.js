const { Router } = require('express')
const router = Router()
const axios = require('axios')
const supabase = require('../services/supabase')
const { transcribeAudio } = require('../services/transcription')
const { handleState, handleErrorFlujo, handleValidandoPago } = require('../controllers/stateController')
const { isBusinessOpen } = require('../utils/time')
// ─── VERIFICACIÓN META ────────────────────────────────────────────────────────

router.get('/', (req, res) => {
  const mode = req.query['hub.mode']
  const token = req.query['hub.verify_token']
  const challenge = req.query['hub.challenge']

  if (mode === 'subscribe' && token === process.env.WEBHOOK_VERIFY_TOKEN) {
    res.status(200).send(challenge)
  } else {
    res.status(403).send('Forbidden')
  }
})

// ─── FUNCIÓN DE ENVÍO ─────────────────────────────────────────────────────────

async function sendMessage(to, text) {
  await axios.post(
    `https://graph.facebook.com/v22.0/${process.env.WHATSAPP_PHONE_ID}/messages`,
    {
      messaging_product: 'whatsapp',
      to,
      type: 'text',
      text: { body: text }
    },
    {
      headers: {
        Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
        'Content-Type': 'application/json'
      }
    }
  )
}

async function sendImage(to, mediaId) {
  await axios.post(
    `https://graph.facebook.com/v22.0/${process.env.WHATSAPP_PHONE_ID}/messages`,
    {
      messaging_product: 'whatsapp',
      to,
      type: 'image',
      image: { id: mediaId }
    },
    {
      headers: {
        Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
        'Content-Type': 'application/json'
      }
    }
  )
}

// ─── WEBHOOK PRINCIPAL ────────────────────────────────────────────────────────

router.post('/', async (req, res) => {
  res.status(200).send('OK')

  try {
    const entry = req.body?.entry?.[0]
    const change = entry?.changes?.[0]?.value
    const message = change?.messages?.[0]

    if (!message || !['text', 'audio', 'image'].includes(message.type)) return
    // Ignorar ediciones de mensajes
    if (message?.context?.edited || message?.edited) return

    const from = message.from
    const phoneNumberId = change.metadata.phone_number_id

    console.log('📞 phoneNumberId recibido:', phoneNumberId)
    console.log('📞 from:', from)

    let { data: business } = await supabase
      .from('businesses')
      .select('*')
      .eq('phone_number', phoneNumberId)
      .single()

    if (!business) {
      const { data: businessById } = await supabase
        .from('businesses')
        .select('*')
        .eq('whatsapp_phone_number_id', phoneNumberId)
        .single()
      business = businessById
    }

    if (!business) {
      console.log('❌ Negocio no encontrado para phoneNumberId:', phoneNumberId)
      return
    }

    console.log('✅ Negocio encontrado:', business.name)

    const isOwner = business.owner_phone === from

    let customer = null

    if (!isOwner) {
      const { data: existingCustomer } = await supabase
        .from('customers')
        .select('*')
        .eq('business_id', business.id)
        .eq('phone_number', from)
        .single()

      if (existingCustomer) {
        customer = existingCustomer
      } else {
        const { data: newCustomer } = await supabase
          .from('customers')
          .insert({
            business_id: business.id,
            phone_number: from,
            state: 'NUEVO',
            state_data: {},
            last_activity: new Date().toISOString()
          })
          .select('*')
          .single()
        customer = newCustomer
      }
    }

    // ── MENSAJES DEL DUEÑO ────────────────────────────────────────────────────
    if (isOwner && message.type === 'text') {
      const text = message.text.body.trim().toLowerCase()

      // CONFIRMAR / RECHAZAR
      if (text === 'confirmar' || text === 'rechazar') {
  const { data: pendingCustomer } = await supabase
    .from('customers')
    .select('*')
    .eq('business_id', business.id)
    .eq('state', 'VALIDANDO_PAGO')
    .order('last_activity', { ascending: true })
    .limit(1)
    .single()

  if (!pendingCustomer) {
    await sendMessage(from, 'No hay pagos pendientes de verificación.')
    return
  }

  // Llamada directa — sin pasar por el switch ni la IA
  await handleValidandoPago(pendingCustomer, business, text, sendMessage)

  const action = text === 'confirmar' ? '✅ confirmado' : '❌ rechazado'
  await sendMessage(from, `Pago ${action}. Cliente +${pendingCustomer.phone_number} fue notificado.`)
  return
}

      // EN CAMINO
      if (text === 'en camino') {
  // DEBUG TEMPORAL
  const { data: allCustomers } = await supabase
    .from('customers')
    .select('phone_number, state')
    .eq('business_id', business.id)
  console.log('🔍 Estados actuales de customers:', JSON.stringify(allCustomers))

  const { data: prepCustomer } = await supabase
    .from('customers')
    .select('*')
    .eq('business_id', business.id)
    .eq('state', 'EN_PREPARACION')
    .order('last_activity', { ascending: true })
    .limit(1)
    .single()

  console.log('🔍 prepCustomer encontrado:', JSON.stringify(prepCustomer))

  if (!prepCustomer) {
    await sendMessage(from, 'No hay pedidos en preparación.')
    return
  }

  const { error: customerUpdateError } = await supabase
    .from('customers')
    .update({ state: 'EN_CAMINO', last_activity: new Date().toISOString() })
    .eq('id', prepCustomer.id)

  console.log('🔍 Error actualizando customer:', customerUpdateError)

  const { error: orderUpdateError } = await supabase
    .from('orders')
    .update({ state: 'EN_CAMINO' })
    .eq('customer_id', prepCustomer.id)
    .eq('state', 'CONFIRMADO')

  console.log('🔍 Error actualizando order:', orderUpdateError)

  await sendMessage(prepCustomer.phone_number,
    '🛵 ¡Tu pedido ya salió! El domiciliario va en camino. En unos minutos está contigo.'
  )
  await sendMessage(from, `✅ Cliente +${prepCustomer.phone_number} notificado — pedido en camino.`)
  return
}

      // ENTREGADO
      if (text === 'entregado') {
        const { data: caminoCustomer } = await supabase
          .from('customers')
          .select('*')
          .eq('business_id', business.id)
          .eq('state', 'EN_CAMINO')
          .order('last_activity', { ascending: true })
          .limit(1)
          .single()

        if (!caminoCustomer) {
          await sendMessage(from, 'No hay pedidos en camino.')
          return
        }

        await supabase
          .from('customers')
          .update({ state: 'ENTREGADO', last_activity: new Date().toISOString() })
          .eq('id', caminoCustomer.id)

        await supabase
          .from('orders')
          .update({ state: 'ENTREGADO' })
          .eq('customer_id', caminoCustomer.id)
          .eq('state', 'EN_CAMINO')

        await sendMessage(caminoCustomer.phone_number,
          '✅ ¡Pedido entregado! Espero que lo disfrutes 😊 Si quieres pedir de nuevo, solo escríbenos.'
        )
        await sendMessage(from, `✅ Cliente +${caminoCustomer.phone_number} — pedido marcado como entregado.`)
        return
      }

      // Comando no reconocido
      await sendMessage(from, 'Comandos disponibles: *confirmar*, *rechazar*, *en camino*, *entregado*')
      return
    }

    if (!customer) return
    // ── HORARIO DE ATENCIÓN ───────────────────────────────────────────────────
if (!isBusinessOpen(business)) {
  const { open_time, close_time } = business
  await sendMessage(from,
    `⏰ En este momento estamos cerrados. Nuestro horario es de ${open_time?.slice(0,5)} a ${close_time?.slice(0,5)}. ¡Escríbenos cuando estemos disponibles!`
  )
  return
}

    // ── PROCESAR MENSAJE DEL CLIENTE ──────────────────────────────────────────
    let userText = ''
    let hasMedia = false

    if (message.type === 'text') {
      userText = message.text.body

    } else if (message.type === 'audio') {
      console.log('Audio recibido, transcribiendo...')
      userText = await transcribeAudio(message.audio.id, business.id)
      console.log('Transcripción:', userText)

    } else if (message.type === 'image') {
      hasMedia = true
      userText = 'comprobante_enviado'

      if (customer.state === 'VALIDANDO_PAGO') {
        await sendMessage(from, '⏳ Ya tenemos tu comprobante en revisión. Espera la confirmación.')
        return
      }

      if (customer.state === 'ESPERANDO_PAGO' && business.owner_phone) {
        await sendImage(business.owner_phone, message.image.id)
      }
    }

    await supabase
      .from('customers')
      .update({ last_activity: new Date().toISOString() })
      .eq('id', customer.id)

    const { data: freshCustomer } = await supabase
      .from('customers')
      .select('*')
      .eq('id', customer.id)
      .single()
      // Después de obtener freshCustomer, antes de handleState
if (freshCustomer.state === 'ENTREGADO') {
  const lastActivity = new Date(freshCustomer.last_activity)
  const minutesPassed = (Date.now() - lastActivity.getTime()) / 1000 / 60

  if (minutesPassed >= 15) {
    await supabase
      .from('customers')
      .update({ state: 'NUEVO', state_data: {}, last_activity: new Date().toISOString() })
      .eq('id', freshCustomer.id)

    const resetCustomer = { ...freshCustomer, state: 'NUEVO', state_data: {} }
    await handleState(resetCustomer, business, userText, hasMedia, sendMessage)
    return
  }
}

await handleState(freshCustomer, business, userText, hasMedia, sendMessage)

  } catch (err) {
    console.error('Error procesando mensaje:', err.message)
    console.error('Detalle:', err.response?.data || err.stack)
  }
})

module.exports = router