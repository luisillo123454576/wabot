const { Router } = require('express')
const router = Router()
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

let userText = ''

if (message.type === 'text') {
  userText = message.text.body
} else if (message.type === 'audio') {
  console.log('Audio recibido, transcribiendo...')
  userText = await transcribeAudio(message.audio.id)
  console.log('Transcripción:', userText)
} else if (message.type === 'image') {
  console.log('Imagen recibida, analizando...')
  
  await sendMessage(from, '⏳ Recibí tu comprobante, estoy verificando el pago...')

  const analisis = await analyzePaymentProof(message.image.id)
  console.log('Análisis:', analisis)

  if (!analisis.es_comprobante) {
    await sendMessage(from, 'No pude identificar esto como un comprobante de pago. ¿Puedes enviar una imagen más clara?')
    return
  }

  if (analisis.confianza === 'alta' && analisis.estado === 'exitoso') {
    await sendMessage(from, `✅ Pago verificado por $${analisis.monto?.toLocaleString()} vía ${analisis.entidad}. ¡Tu pedido está confirmado y en preparación!`)
    
    // Notificar al dueño
    if (business?.owner_phone) {
      await sendMessage(
        business.owner_phone,
        `💰 Pago recibido:\nCliente: +${from}\nMonto: $${analisis.monto?.toLocaleString()}\nEntidad: ${analisis.entidad}\nFecha: ${analisis.fecha}\n\nEl pedido fue confirmado automáticamente.`
      )
    }
  } else {
    await sendMessage(from, '⏳ Tu comprobante está en revisión. El negocio lo verificará en un momento y te confirmamos.')
    
    // Notificar al dueño para revisión manual
    if (business?.owner_phone) {
      await sendMessage(
        business.owner_phone,
        `⚠️ Comprobante requiere revisión manual:\nCliente: +${from}\nMonto detectado: $${analisis.monto?.toLocaleString()}\nEntidad: ${analisis.entidad}\nConfianza: ${analisis.confianza}\n\nResponde OK para confirmar o NO para rechazar.`
      )
    }
  }
  return
}
    const from = message.from
    const phoneNumberId = change.metadata.phone_number_id

    // Buscar negocio
    const { data: business } = await supabase
      .from('businesses')
      .select('*')
      .eq('phone_number', phoneNumberId)
      .single()

    const businessContext = business
      ? business.ai_context
      : 'Eres un asistente general. El negocio aún no ha configurado su información.'

    // Buscar o crear cliente
    let customerId = null
    if (business) {
      const { data: existingCustomer } = await supabase
        .from('customers')
        .select('id')
        .eq('business_id', business.id)
        .eq('phone_number', from)
        .single()

      if (existingCustomer) {
        customerId = existingCustomer.id
      } else {
        const { data: newCustomer } = await supabase
          .from('customers')
          .insert({ business_id: business.id, phone_number: from })
          .select('id')
          .single()
        customerId = newCustomer.id
      }
    }

    // Historial de conversación del cliente
    const { data: history } = await supabase
      .from('conversations')
      .select('role, message')
      .eq('customer_id', customerId || '00000000-0000-0000-0000-000000000000')
      .order('created_at', { ascending: true })
      .limit(10)

    const conversationHistory = (history || []).map(h => ({
      role: h.role,
      content: h.message
    }))

    const aiReply = await getAIResponse(businessContext, conversationHistory, userText)
    console.log('AI reply:', aiReply)

    await sendMessage(from, aiReply)

    // Guardar mensajes con customer_id real
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