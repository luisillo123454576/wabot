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
async function generateFreeResponse(businessContext, userMessage, currentState = null, stateData = null) {
  
  // Contexto del estado actual para que la IA sepa dónde está parada
  let stateContext = ''
  
  if (currentState) {
    const stateDescriptions = {
      'MENU_ENVIADO': 'El cliente acaba de recibir el menú y está decidiendo qué pedir.',
      'ARMANDO_PEDIDO': `El cliente está armando su pedido. Carrito actual: ${stateData?.items?.length > 0 ? stateData.items.map(i => `${i.quantity}x ${i.name}`).join(', ') : 'vacío'}.`,
      'ESPERANDO_DIRECCION': 'El cliente ya confirmó su pedido y está a punto de dar su dirección de entrega.',
      'ESPERANDO_PAGO': `El cliente debe enviar el comprobante de pago. Total a cobrar: $${(stateData?.total || 0).toLocaleString('es-CO')}.`,
      'VALIDANDO_PAGO': 'El cliente ya envió el comprobante y está esperando confirmación del negocio.',
      'EN_PREPARACION': 'El pedido del cliente ya fue confirmado y está siendo preparado en cocina.',
      'EN_CAMINO': 'El pedido ya salió a domicilio y está en camino al cliente.',
      'ENTREGADO': 'El pedido fue entregado. El cliente puede querer hacer un nuevo pedido o dar feedback.'
    }
    
    stateContext = stateDescriptions[currentState] 
      ? `\nCONTEXTO ACTUAL: ${stateDescriptions[currentState]}` 
      : ''
  }

  const response = await groq.chat.completions.create({
    model: 'llama-3.1-8b-instant',
    max_tokens: 200,
    messages: [
      {
        role: 'system',
        content: `Eres el asistente de apoyo de un negocio en WhatsApp. 
Tu rol es responder preguntas puntuales que el cliente hace durante el proceso de compra.
NO eres el encargado del flujo del pedido — eso lo maneja el sistema automáticamente.
NO confirmes pedidos, NO cambies precios, NO inventes información.
Si no sabes algo, di "eso lo confirmo con el equipo enseguida".
Responde en español informal y natural, máximo 2 líneas.
${stateContext}

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