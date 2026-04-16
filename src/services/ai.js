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
CONFIRMAR       (ejemplos: "listo", "eso es todo", "no mas", "ya esta", "confirmo")
CANCELAR        (ejemplos: "cancela", "no quiero nada", "dejalo", "olvida")
ENVIO_COMPROBANTE
REPETIR_PEDIDO
PAGO_EFECTIVO   (ejemplos: "pago en efectivo", "pago al llegar", "pago contra entrega", "en efectivo", "cash", "cuando llegue pago")
PREGUNTA_LIBRE

Responde solo la palabra exacta. Sin explicacion.`
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
    max_tokens: 300,
    messages: [
      {
        role: 'user',
        content: `Menú disponible:
${menuList}

Mensaje del cliente: "${userMessage}"

Extrae TODOS los productos mencionados. Responde SOLO en JSON con este formato exacto:
{"items":[{"producto":"nombre exacto del producto","cantidad":1}]}

Si el cliente menciona varios productos, inclúyelos todos en el array.
Si no puedes identificar ningún producto responde:
{"items":[]}`
      }
    ]
  })

  const raw = response.choices[0].message.content.trim()
  try {
    const clean = raw.replace(/```json|```/g, '').trim()
    return JSON.parse(clean)
  } catch {
    return { items: [] }
  }
}
// NUEVA Función: Validar si el texto es una dirección (IA como Fallback)
async function isValidAddress(userMessage) {
  const response = await groq.chat.completions.create({
    model: 'llama-3.1-8b-instant',
    max_tokens: 10,
    messages: [
      {
        role: 'system',
        content: 'Eres un validador de direcciones. Responde "SI" si el texto parece una dirección de entrega. Responde "NO" si es un comentario, duda o saludo.'
      },
      {
        role: 'user',
        content: `¿Es esto una dirección?: "${userMessage}"`
      }
    ]
  });
  const result = response.choices[0].message.content.trim().toUpperCase();
  return result.includes('SI');
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
    max_tokens: 150,
    messages: [
      {
        role: 'system',
        content: `Eres un asistente de INFORMACIÓN para Burger Factory. 
        REGLAS CRÍTICAS:
        1. NO intentes tomar pedidos. Si el cliente quiere algo, dile que solo lo escriba y el sistema lo anotará.
        2. NO hables de pagos, comprobantes ni envíos a menos que el cliente pregunte explícitamente "¿Cómo pago?" o "¿Dónde están?".
        3. Si el cliente está pidiendo comida, NO INTERVENGAS con sugerencias, deja que el sistema lo procese.
        4. Sé extremadamente breve (máximo 1 línea y media). Tono costeño.
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

module.exports = { classifyIntent, extractOrderItems, generateFreeResponse, isValidAddress }