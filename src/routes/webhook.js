const { Router } = require('express')
const router = Router()
const axios = require('axios')
const supabase = require('../services/supabase')
const { transcribeAudio } = require('../services/transcription')
const { handleState, handleErrorFlujo } = require('../controllers/stateController')

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

    const from = message.from
    const phoneNumberId = change.metadata.phone_number_id
    
    // LOG para depuración
    console.log('📞 phoneNumberId recibido:', phoneNumberId)
    console.log('📞 from:', from)

    // ── Buscar negocio por phone_number o whatsapp_phone_number_id ──────────────
    let { data: business } = await supabase
      .from('businesses')
      .select('*')
      .eq('phone_number', phoneNumberId)
      .single()

    if (!business) {
      // Intentar buscar por whatsapp_phone_number_id
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

    // ── Detectar si el mensaje viene del dueño ────────────────────────────────
    const isOwner = business.owner_phone === from

    // ── Buscar o crear cliente ────────────────────────────────────────────────
    let customer = null

    if (isOwner) {
      // El dueño no es un cliente, se maneja aparte
    } else {
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

      if (text === 'confirmar' || text === 'rechazar') {
        // Buscar el cliente que está en VALIDANDO_PAGO
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

        await handleState(
          pendingCustomer,
          business,
          text,
          false,
          sendMessage
        )

        const action = text === 'confirmar' ? '✅ confirmado' : '❌ rechazado'
        await sendMessage(from, `Pago ${action}. Cliente +${pendingCustomer.phone_number} fue notificado.`)
      } else {
        await sendMessage(from, 'Comandos disponibles: *confirmar* o *rechazar*')
      }
      return
    }

    if (!customer) return

    // ── PROCESAR MENSAJE DEL CLIENTE ──────────────────────────────────────────
    let userText = ''
    let hasMedia = false

    if (message.type === 'text') {
      userText = message.text.body

    } else if (message.type === 'audio') {
      console.log('Audio recibido, transcribiendo...')
      userText = await transcribeAudio(message.audio.id)
      console.log('Transcripción:', userText)

    } else if (message.type === 'image') {
      hasMedia = true
      userText = 'comprobante_enviado'

      // Si el cliente está en VALIDANDO_PAGO ya, no reenviar
      if (customer.state === 'VALIDANDO_PAGO') {
        await sendMessage(from, '⏳ Ya tenemos tu comprobante en revisión. Espera la confirmación.')
        return
      }

      // Solo reenviar imagen al dueño si está ESPERANDO_PAGO
      if (customer.state === 'ESPERANDO_PAGO' && business.owner_phone) {
        await sendImage(business.owner_phone, message.image.id)
      }
    }

    // ── Actualizar last_activity ───────────────────────────────────────────────
    await supabase
      .from('customers')
      .update({ last_activity: new Date().toISOString() })
      .eq('id', customer.id)

    // Refrescar customer con state_data actualizado
    const { data: freshCustomer } = await supabase
      .from('customers')
      .select('*')
      .eq('id', customer.id)
      .single()

    // ── Enrutar al controlador de estados ────────────────────────────────────
    await handleState(freshCustomer, business, userText, hasMedia, sendMessage)

  } catch (err) {
    console.error('Error procesando mensaje:', err.message)
    console.error('Detalle:', err.response?.data || err.stack)
  }
})

module.exports = router