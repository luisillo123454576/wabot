const Groq = require('groq-sdk')

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY })

async function getAIResponse(businessContext, conversationHistory, userMessage) {
  const messages = [
    {
      role: 'system',
      content: `Eres un asistente de ventas para el siguiente negocio. Responde siempre en español, de forma amable y concisa.\n\nInformación del negocio:\n${businessContext}`
    },
    ...conversationHistory.map(h => ({
      role: h.role === 'assistant' ? 'assistant' : 'user',
      content: h.content
    })),
    { role: 'user', content: userMessage }
  ]

  const response = await groq.chat.completions.create({
    model: 'llama-3.3-70b-versatile',
    messages,
    max_tokens: 1000
  })

  return response.choices[0].message.content
}

module.exports = { getAIResponse }