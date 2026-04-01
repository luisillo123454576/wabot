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

    // Buscar negocio
    const { data: business } = await supabase
      .from('businesses')
      .select('*')
      .eq('phone_number', phoneNumberId)
      .single()

    // Buscar o crear cliente
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
          .insert({ business_id: business.id, phone_number: from, last_interaction: new Date().toISOString() })
          .select('id')
          .single()
        customerId = newCustomer.id
      }
    }

    // Buscar orden activa del cliente
    const { data: activeOrder } = await supabase
      .from('orders')
      .select('*')
      .eq('business_id', business?.id)
      .eq('customer_phone', from)
      .in('status', ['pending_payment', 'in_preparation'])
      .order('created_at', { ascending: false })
      .limit(1)
      .single()

    // Auto-marcar como entregado si pasaron 45 minutos en preparacion
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

        activeOrder.status = 'delivered'
      }
    }

    // Detectar si quien escribe es el dueño
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

    // Manejar imagen
    if (message.type === 'image') {
      console.log('Imagen recibida, analizando...')

      // Evitar duplicado si ya hay un pago pendiente
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

      // Crear orden
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

    // Manejar texto y audio
    let userText = ''

    if (message.type === 'text') {
      userText = message.text.body
    } else if (message.type === 'audio') {
      console.log('Audio recibido, transcribiendo...')
      userText = await transcribeAudio(message.audio.id)
      console.log('Transcripción:', userText)
    }

    // Verificar tiempo desde última interacción
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

    // Construir contexto según estado de la orden activa
    let orderContext = ''
    if (activeOrder?.status === 'in_preparation') {
      orderContext = `\n\nESTADO ACTUAL: El cliente tiene un pedido EN PREPARACIÓN con los siguientes detalles:\n${activeOrder.order_details}\nEl pedido fue confirmado y está siendo preparado. Si el cliente pregunta por su pedido, infórmale que está en preparación y llegará pronto. NO pidas dirección ni datos de pago de nuevo.`
    } else if (activeOrder?.status === 'pending_payment') {
      orderContext = `\n\nESTADO ACTUAL: El cliente tiene un comprobante de pago PENDIENTE de verificación. Dile que espere la confirmación del negocio. NO aceptes un nuevo pedido hasta que este sea resuelto.`
    } else if (!activeOrder || activeOrder?.status === 'delivered') {
      orderContext = '\n\nESTADO ACTUAL: No hay pedidos activos. El cliente puede hacer un pedido nuevo.'
    }

    const businessContext = (business
      ? business.ai_context
      : 'Eres un asistente general. El negocio aún no ha configurado su información.') + orderContext

    // Historial: vacío si pasaron más de 8 horas
    const useHistory = hoursElapsed <= 8
    const { data: history } = useHistory
      ? await supabase
          .from('conversations')
          .select('role, message')
          .eq('customer_id', customerId || '00000000-0000-0000-0000-000000000000')
          .order('created_at', { ascending: true })
          .limit(10)
      : { data: [] }

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