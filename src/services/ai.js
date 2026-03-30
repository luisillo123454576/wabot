const { GoogleGenerativeAI } = require('@google/generative-ai')

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY)

async function getAIResponse(businessContext, conversationHistory, userMessage) {
  const model = genAI.getGenerativeModel({
    model: 'gemini-2.0-flash',
    systemInstruction: `Eres un asistente de ventas para el siguiente negocio. Responde siempre en español, de forma amable y concisa.\n\nInformación del negocio:\n${businessContext}`
  })

  const history = conversationHistory.map(h => ({
    role: h.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: h.content }]
  }))

  const chat = model.startChat({ history })
  const result = await chat.sendMessage(userMessage)
  return result.response.text()
}

module.exports = { getAIResponse }