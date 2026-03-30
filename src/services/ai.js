const axios = require('axios')

async function getAIResponse(businessContext, conversationHistory, userMessage) {
  const response = await axios.post(
    'https://api.anthropic.com/v1/messages',
    {
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1000,
      system: `Eres un asistente de ventas para el siguiente negocio. Responde siempre en español, de forma amable y concisa.

Información del negocio:
${businessContext}`,
      messages: [
        ...conversationHistory,
        { role: 'user', content: userMessage }
      ]
    },
    {
      headers: {
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json'
      }
    }
  )

  return response.data.content[0].text
}

module.exports = { getAIResponse }