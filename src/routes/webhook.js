const { Router } = require('express')
const router = Router()
const { getAIResponse } = require('../services/ai')
const { sendMessage } = require('../services/whatsapp')
const supabase = require('../services/supabase')

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

    if (!message || message.type !== 'text') return

    const from = message.from
    const userText = message.text.body
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