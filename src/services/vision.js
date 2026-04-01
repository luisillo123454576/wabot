const { GoogleGenerativeAI } = require('@google/generative-ai')
const axios = require('axios')

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY)

async function analyzePaymentProof(mediaId) {
  // Descargar imagen desde Meta
  const mediaResponse = await axios.get(
    `https://graph.facebook.com/v22.0/${mediaId}`,
    { headers: { Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}` } }
  )

  const imageResponse = await axios.get(mediaResponse.data.url, {
    headers: { Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}` },
    responseType: 'arraybuffer'
  })

  const base64Image = Buffer.from(imageResponse.data).toString('base64')
  const mimeType = mediaResponse.data.mime_type || 'image/jpeg'

  const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' })

  const result = await model.generateContent([
    {
      inlineData: {
        data: base64Image,
        mimeType
      }
    },
    `Analiza este comprobante de pago y responde SOLO en este formato JSON sin texto adicional:
{
  "es_comprobante": true o false,
  "monto": número o null,
  "entidad": "nombre del banco o plataforma" o null,
  "fecha": "fecha del pago" o null,
  "estado": "exitoso" o "pendiente" o "fallido" o "dudoso",
  "confianza": "alta" o "media" o "baja"
}`
  ])

  const text = result.response.text().replace(/```json|```/g, '').trim()
  return JSON.parse(text)
}

module.exports = { analyzePaymentProof }