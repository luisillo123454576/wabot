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
async function classifyDireccion(userMessage) {
  const response = await groq.chat.completions.create({
    model: 'llama-3.1-8b-instant',
    max_tokens: 10,
    messages: [{
      role: 'user',
      content: `El usuario acaba de recibir la pregunta "¿Confirmamos la dirección o quieres corregirla?"
Su respuesta fue: "${userMessage}"
Clasifica en UNA opción: CONFIRMAR / NUEVA_DIRECCION / PREGUNTA_LIBRE
Solo la palabra exacta.`
    }]
  })
  return response.choices[0].message.content.trim().toUpperCase()
}

module.exports = { classifyIntent, extractOrderItems, generateFreeResponse, isValidAddress, classifyDireccion }
// Función 2: extraer ítems del pedido cuando alias no detectó nada
async function extractAddress(userMessage) {
  const response = await groq.chat.completions.create({
    model: 'llama-3.1-8b-instant',
    max_tokens: 50,
    messages: [
      {
        role: 'system',
        content: `Eres un extractor de direcciones. 
REGLAS ABSOLUTAS:
1. Extrae ÚNICAMENTE la dirección de entrega del texto.
2. Devuelve SOLO la dirección, sin puntos, sin comillas, sin explicación, sin palabras extra.
3. Si el texto contiene "quiero corregirla era Calle 35#3", devuelves: Calle 35#3
4. Si el texto YA ES una dirección limpia como "Calle 35#3 este 20", devuelves: Calle 35#3 este 20
5. NUNCA devuelvas frases como "la dirección es..." o "aquí está...".
6. Si no encuentras ninguna dirección, devuelve: NONE`
      },
      {
        role: 'user',
        content: userMessage
      }
    ]
  })
  const result = response.choices[0].message.content.trim()
  return result === 'NONE' ? null : result
}

module.exports = { classifyIntent, extractOrderItems, generateFreeResponse, isValidAddress, classifyDireccion, extractAddress }
async function extractOrderItems(userMessage, menuItems) {
  const menuList = menuItems.map(p => `- "${p.name}"`).join('\n')

  const response = await groq.chat.completions.create({
    model: 'llama-3.1-8b-instant',
    max_tokens: 300,
    messages: [
      {
        role: 'system',
        content: `Eres un mapeador de pedidos. Tu único trabajo es relacionar lo que el cliente escribió con el nombre exacto del producto en el menú, aunque esté mal escrito o abreviado.
REGLAS ABSOLUTAS:
1. SOLO puedes usar nombres que existan exactamente en el menú proporcionado.
2. Si el cliente escribió "amburguesa clasica" y en el menú existe "Hamburguesa Clásica", devuelves "Hamburguesa Clásica".
3. NUNCA devuelvas un producto que no esté en el menú.
4. Si no puedes mapear algo con certeza, ignóralo.
5. Devuelve ÚNICAMENTE el JSON sin ningún texto adicional.`
      },
      {
        role: 'user',
        content: `Menú disponible:
${menuList}

Mensaje del cliente: "${userMessage}"

Mapea cada producto mencionado al nombre exacto del menú.
Responde ÚNICAMENTE con este JSON:
{"items":[{"producto":"nombre exacto del menú","cantidad":1}]}

Si no encuentras ningún producto válido: {"items":[]}`
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
  
  const stateDescriptions = {
    'MENU_ENVIADO': 'El cliente acaba de recibir el menú. SOLO responde si pregunta algo específico del menú como ingredientes o alergias. Si dice que quiere algo, responde: "¡Dime qué quieres y lo anoto! 😊"',
    'ARMANDO_PEDIDO': `El cliente está armando su pedido. Carrito actual: ${stateData?.items?.length > 0 ? stateData.items.map(i => `${i.quantity}x ${i.name}`).join(', ') : 'vacío'}. SOLO confirma lo que hay en el carrito si pregunta. No sugieras productos.`,
    'ESPERANDO_DIRECCION': 'El cliente debe dar su dirección. SOLO dile que escriba su dirección de entrega. Nada más.',
    'ESPERANDO_PAGO': `El cliente debe enviar el comprobante. Total: $${(stateData?.total || 0).toLocaleString('es-CO')}. SOLO recuérdale que envíe la foto del comprobante.`,
    'VALIDANDO_PAGO': 'El pago está en verificación. SOLO dile que espere la confirmación. Máximo 1 línea.',
    'EN_PREPARACION': 'El pedido está en cocina. SOLO dile que está siendo preparado y el tiempo estimado es 25-35 min.',
    'EN_CAMINO': 'El pedido va en camino. SOLO dile que el domiciliario ya va hacia allá.',
    'ENTREGADO': 'El pedido fue entregado. Pregúntale si quiere hacer otro pedido.'
  }

  const stateContext = stateDescriptions[currentState] || 'Responde brevemente y redirige al flujo de pedido.'

  const response = await groq.chat.completions.create({
    model: 'llama-3.1-8b-instant',
    max_tokens: 60,
    messages: [
      {
        role: 'system',
        content: `Eres el asistente de ${businessContext || 'este negocio'}.
REGLAS ABSOLUTAS:
1. NUNCA tomes pedidos ni anotes productos — eso lo hace el sistema automáticamente.
2. NUNCA inventes estados, precios ni productos.
3. NUNCA respondas más de 1 línea.
4. Tu único trabajo es responder la pregunta puntual del cliente según su estado actual.
5. Si el cliente quiere pedir algo, dile SOLAMENTE: "¡Dime qué quieres y lo anoto! 😊"

ESTADO ACTUAL DEL CLIENTE: ${stateContext}`
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