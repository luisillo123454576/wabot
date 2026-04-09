const { Router } = require('express')
const router = Router()
const axios = require('axios')
const { getAIResponse } = require('../services/ai')
const { sendMessage } = require('../services/whatsapp')
const supabase = require('../services/supabase')
const { transcribeAudio } = require('../services/transcription')
const { analyzePaymentProof } = require('../services/vision')

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

router.post('/', async (req, res) => {
  res.status(200).send('OK')
  console.log('POST recibido, procesando...')

  try {
    const entry = req.body?.entry?.[0]
    const change = entry?.changes?.[0]?.value
    const message = change?.messages?.[0]

    if (!message || !['text', 'audio', 'image'].includes(message.type)) return

    const from = message.from
    const phoneNumberId = change.metadata.phone_number_id

    const { data: business } = await supabase
      .from('businesses')
      .select('*')
      .eq('phone_number', phoneNumberId)
      .single()

    let customerId = null
    if (business) {
      const { data: existingCustomer } = await supabase
        .from('customers')
        .select('id, last_interaction')
        .eq('business_id', business.id)
        .eq('phone_number', from)
        .single()

      if (existingCustomer) {
        customerId = existingCustomer.id
      } else {
        const { data: newCustomer } = await supabase
          .from('customers')
          .insert({
            business_id: business.id,
            phone_number: from,
            last_interaction: new Date().toISOString()
          })
          .select('id')
          .single()
        customerId = newCustomer.id
      }
    }

    let { data: activeOrder } = await supabase
      .from('orders')
      .select('*')
      .eq('business_id', business?.id)
      .eq('customer_phone', from)
      .in('status', ['pending_payment', 'in_preparation'])
      .order('created_at', { ascending: false })
      .limit(1)
      .single()

    if (activeOrder?.status === 'in_preparation') {
      const minutesElapsed = (Date.now() - new Date(activeOrder.created_at).getTime()) / (1000 * 60)
      if (minutesElapsed >= 45) {
        await supabase
          .from('orders')
          .update({ status: 'delivered', delivered_at: new Date().toISOString() })
          .eq('id', activeOrder.id)

        await supabase
          .from('conversations')
          .delete()
          .eq('customer_id', customerId)

        activeOrder = null
      }
    }

    const isOwner = business?.owner_phone === from

    if (isOwner && message.type === 'text') {
      const response = message.text.body.trim().toUpperCase()

      if (response === 'OK' || response === 'NO') {
        const { data: pending } = await supabase
          .from('orders')
          .select('*')
          .eq('business_id', business.id)
          .eq('status', 'pending_payment')
          .order('created_at', { ascending: true })
          .limit(1)
          .single()

        if (!pending) {
          await sendMessage(from, 'No hay pagos pendientes por verificar.')
          return
        }

        if (response === 'OK') {
          await supabase
            .from('orders')
            .update({ status: 'in_preparation' })
            .eq('id', pending.id)

          await sendMessage(
            pending.customer_phone,
            '✅ ¡Tu pago fue confirmado! Tu pedido está en preparación. En breve te lo llevamos. 🍔🔥'
          )
          await sendMessage(from, `✅ Pago confirmado. Pedido en preparación. Cliente +${pending.customer_phone} fue notificado.`)
        } else {
          await supabase
            .from('orders')
            .update({ status: 'delivered' })
            .eq('id', pending.id)

          const { data: rejectedCustomer } = await supabase
            .from('customers')
            .select('id')
            .eq('business_id', business.id)
            .eq('phone_number', pending.customer_phone)
            .single()

          if (rejectedCustomer) {
            await supabase
              .from('conversations')
              .delete()
              .eq('customer_id', rejectedCustomer.id)
          }

          await sendMessage(
            pending.customer_phone,
            '❌ No pudimos verificar tu pago. Por favor contáctanos directamente para resolver esto.'
          )
          await sendMessage(from, `❌ Pago rechazado. Cliente +${pending.customer_phone} fue notificado.`)
        }
        return
      }
    }

    if (message.type === 'image') {
      console.log('Imagen recibida, analizando...')

      if (activeOrder?.status === 'pending_payment') {
        await sendMessage(from, '⏳ Ya tenemos tu comprobante en revisión. Espera la confirmación.')
        return
      }

      await sendMessage(from, '⏳ Recibí tu comprobante, estoy verificando el pago. Dame un momento...')

      await analyzePaymentProof(message.image.id)

      const { data: recentHistory } = await supabase
        .from('conversations')
        .select('role, message')
        .eq('customer_id', customerId || '00000000-0000-0000-0000-000000000000')
        .order('created_at', { ascending: false })
        .limit(20)

      const allAssistantMessages = (recentHistory || [])
        .filter(h => h.role === 'assistant')
        .map(h => h.message)

      const orderMessage = allAssistantMessages.find(m =>
        m.includes('total') || m.includes('Total') || m.includes('$')
      ) || allAssistantMessages[0] || 'Sin resumen disponible.'

      const orderSummary = orderMessage.length > 300
        ? orderMessage.substring(0, 300) + '...'
        : orderMessage

      await supabase
        .from('orders')
        .insert({
          business_id: business?.id,
          customer_phone: from,
          customer_id: customerId,
          order_details: orderSummary,
          status: 'pending_payment'
        })

      if (business?.owner_phone) {
        await axios.post(
          `https://graph.facebook.com/v22.0/${process.env.WHATSAPP_PHONE_ID}/messages`,
          {
            messaging_product: 'whatsapp',
            to: business.owner_phone,
            type: 'image',
            image: { id: message.image.id }
          },
          {
            headers: {
              Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
              'Content-Type': 'application/json'
            }
          }
        )

        await sendMessage(
          business.owner_phone,
          `💰 Comprobante recibido\nCliente: +${from}\n\n📋 Pedido:\n${orderSummary}\n\nResponde OK para confirmar o NO para rechazar.`
        )
      }
      return
    }

    let userText = ''

    if (message.type === 'text') {
      userText = message.text.body
    } else if (message.type === 'audio') {
      console.log('Audio recibido, transcribiendo...')
      userText = await transcribeAudio(message.audio.id)
      console.log('Transcripción:', userText)
    }

    // Detector de entrega robusto con doble capa
    if (activeOrder?.status === 'in_preparation') {

      // Capa 1: palabras clave explícitas — cero tokens, instantáneo
      const deliveryPhrases = [
        'ya llegó', 'ya llego', 'ya me llegó', 'ya me llego',
        'ya lo recibí', 'ya lo recibi', 'llegó el pedido', 'llego el pedido',
        'ya llegaron', 'me llegó', 'me llego', 'acaba de llegar',
        'llegó ahorita', 'llegó ahora', 'ya lo tengo', 'ya está aquí',
        'ya esta aqui', 'ya llegó todo', 'recibido', 'lo recibi',
        'lo recibí', 'llegó ya', 'llego ya'
      ]

      const msgLower = userText.toLowerCase().trim()
      const keywordMatch = deliveryPhrases.some(phrase => msgLower.includes(phrase))

      // Capa 2: IA solo si no hubo match por keywords
      // Con instrucción estricta para evitar falsos positivos
      let aiConfirmedDelivery = false
      if (!keywordMatch) {
        const detectionResponse = await getAIResponse(
          `Eres un detector de confirmación de entrega física. 
Tu única función es determinar si el mensaje del cliente indica que el pedido ya llegó físicamente a sus manos.

RESPONDE SOLO "SI" EN ESTOS CASOS EXACTOS:
- El cliente dice que el pedido ya llegó a su ubicación
- El cliente dice que ya lo recibió en sus manos
- El cliente confirma la entrega de forma inequívoca

RESPONDE "NO" EN TODOS ESTOS CASOS:
- El cliente expresa emoción, anticipación o entusiasmo ("qué rico", "lo espero con ansias", "perfecto")
- El cliente agradece sin confirmar entrega ("gracias", "ok", "listo")
- El cliente pregunta algo sobre el pedido
- El cliente hace cualquier comentario que no sea confirmación explícita de entrega física
- Cualquier duda → NO

Responde ÚNICAMENTE con SI o NO, sin ningún texto adicional.`,
          [],
          `Mensaje del cliente: "${userText}"`
        )
        aiConfirmedDelivery = detectionResponse.trim().toUpperCase() === 'SI'
      }

      if (keywordMatch || aiConfirmedDelivery) {
        console.log(`Entrega confirmada. Keyword: ${keywordMatch}, IA: ${aiConfirmedDelivery}`)

        await supabase
          .from('orders')
          .update({ status: 'delivered', delivered_at: new Date().toISOString() })
          .eq('id', activeOrder.id)

        await supabase
          .from('conversations')
          .delete()
          .eq('customer_id', customerId)

        activeOrder = null

        await sendMessage(from, '¡Perfecto! Que lo disfrutes. Cuando quieras pedir de nuevo aquí estamos.')
        return
      }
    }

    const { data: customerRecord } = await supabase
      .from('customers')
      .select('last_interaction')
      .eq('id', customerId)
      .single()

    const lastInteraction = customerRecord?.last_interaction
      ? new Date(customerRecord.last_interaction)
      : null

    const hoursElapsed = lastInteraction
      ? (Date.now() - lastInteraction.getTime()) / (1000 * 60 * 60)
      : 999

    if (customerId) {
      await supabase
        .from('customers')
        .update({ last_interaction: new Date().toISOString() })
        .eq('id', customerId)
    }

    let orderContext = ''
    if (activeOrder?.status === 'in_preparation') {
      orderContext = `\n\nESTADO ACTUAL: PEDIDO EN PREPARACIÓN.
Detalles: ${activeOrder.order_details}
INSTRUCCIÓN ESTRICTA: Responde SOLO sobre el estado del pedido. Tranquiliza al cliente, dile que está en preparación y llegará pronto. NO pidas dirección ni datos de pago. NO ofrezcas nuevo pedido.`
    } else if (activeOrder?.status === 'pending_payment') {
      orderContext = `\n\nESTADO ACTUAL: PAGO PENDIENTE DE VERIFICACIÓN.
INSTRUCCIÓN ESTRICTA: Dile que su comprobante está siendo revisado y que en breve recibe confirmación. NO aceptes nuevo pedido. NO pidas datos adicionales.`
    } else {
      orderContext = '\n\nESTADO ACTUAL: Sin pedidos activos. El cliente puede hacer un pedido nuevo.'
    }

    const businessContext = (business
      ? business.ai_context
      : 'Eres un asistente general. El negocio aún no ha configurado su información.') + orderContext

    // Bloquear historial SOLO cuando hay orden activa confirmada
    const blockHistory = activeOrder?.status === 'in_preparation' ||
                         activeOrder?.status === 'pending_payment'

    const resetSession = hoursElapsed > 4 && !blockHistory

    const { data: history } = (blockHistory || resetSession)
      ? { data: [] }
      : await supabase
          .from('conversations')
          .select('role, message')
          .eq('customer_id', customerId || '00000000-0000-0000-0000-000000000000')
          .order('created_at', { ascending: true })
          .limit(15)

    const conversationHistory = (history || []).map(h => ({
      role: h.role,
      content: h.message
    }))

    const aiReply = await getAIResponse(businessContext, conversationHistory, userText)
    console.log('AI reply:', aiReply)

    await sendMessage(from, aiReply)

    if (business && customerId) {
      await supabase.from('conversations').insert([
        { business_id: business.id, customer_id: customerId, role: 'user', message: userText },
        { business_id: business.id, customer_id: customerId, role: 'assistant', message: aiReply }
      ])
    }
  } catch (err) {
    console.error('Error procesando mensaje:', err.message)
    console.error('Error completo:', err.response?.data || err.message)
  }
})

module.exports = router