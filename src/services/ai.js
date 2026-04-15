const Groq = require('groq-sdk')

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY })

// Función 1: clasificar intención del mensaje
async function classifyIntent(currentState, userMessage) {
  const response = await groq.chat.completions.create({
    model: 'llama-3.1-8b-instant',
    max_tokens: 10,
    messages: [
      {
        role: 'user',
        content: `Estado actual del usuario: ${currentState}
Mensaje recibido: "${userMessage}"

Clasifica en UNA de estas opciones:
HACER_PEDIDO
VER_MENU
CONFIRMAR
CANCELAR
ENVIO_COMPROBANTE
REPETIR_PEDIDO
PREGUNTA_LIBRE

Responde solo la palabra exacta. Sin explicación.`
      }
    ]
  })

  return response.choices[0].message.content.trim()
}

// Función 2: extraer ítems del pedido cuando alias no detectó nada
async function extractOrderItems(userMessage, menuItems) {
  const menuList = menuItems.map(p => `- ${p.name}`).join('\n')

  const response = await groq.chat.completions.create({
    model: 'llama-3.1-8b-instant',
    max_tokens: 100,
    messages: [
      {
        role: 'user',
        content: `Menú disponible:
${menuList}

Mensaje del cliente: "${userMessage}"

Extrae el pedido. Responde SOLO en JSON con este formato exacto:
{"producto":"nombre exacto del producto","cantidad":1}

Si no puedes identificar el producto responde:
{"producto":null,"cantidad":0}`
      }
    ]
  })

  const raw = response.choices[0].message.content.trim()
  try {
    const clean = raw.replace(/```json|```/g, '').trim()
    return JSON.parse(clean)
  } catch {
    return { producto: null, cantidad: 0 }
  }
}

// Función 3: respuesta libre para preguntas fuera del flujo
async function generateFreeResponse(businessContext, userMessage) {
  const response = await groq.chat.completions.create({
    model: 'llama-3.1-8b-instant',
    max_tokens: 200,
    messages: [
      {
        role: 'system',
        content: `Eres el asistente de WhatsApp de un negocio. 
Responde en español informal y natural.
Sé conciso, máximo 3 líneas.
Si no sabes algo di "eso lo confirmo con el equipo enseguida".
Nunca inventes precios ni confirmes pedidos.
Información del negocio:
${businessContext}`
      },
      {
        role: 'user',
        content: userMessage
      }
    ]
  })

  return response.choices[0].message.content.trim()
}

module.exports = { classifyIntent, extractOrderItems, generateFreeResponse }