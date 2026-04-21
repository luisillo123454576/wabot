const Groq = require('groq-sdk')
const supabase = require('./supabase')

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY })

// ── RETRY HELPER ──────────────────────────────────────────────────────────────
async function groqCall(params, retries = 2, delay = 1000) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await groq.chat.completions.create(params)
    } catch (err) {
      const isLast = attempt === retries
      const retryable = err?.status === 503 || err?.status === 429 || err?.code === 'ECONNRESET' || err?.code === 'ETIMEDOUT'
      
      if (isLast || !retryable) {
        console.error(`Groq falló — attempt ${attempt + 1}:`, err.message)
        throw err
      }
      
      console.warn(`Groq retry ${attempt + 1}/${retries} en ${delay}ms...`)
      await new Promise(r => setTimeout(r, delay * (attempt + 1)))
    }
  }
}

async function logAiCall(businessId, functionName, response) {
  try {
    await supabase.from('ai_calls').insert({
      business_id: businessId || null,
      function_name: functionName,
      model: response.model || 'llama-3.1-8b-instant',
      tokens_input: response.usage?.prompt_tokens || 0,
      tokens_output: response.usage?.completion_tokens || 0,
    })
  } catch (e) {
    console.error('Error logging ai_call:', e.message)
  }
}

async function classifyIntent(currentState, userMessage, businessId = null) {
  try {
    const response = await groqCall({
      model: 'llama-3.1-8b-instant',
      max_tokens: 10,
      messages: [{
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
      }]
    })
    await logAiCall(businessId, 'classifyIntent', response)
    return response.choices[0].message.content.trim()
  } catch {
    return 'PREGUNTA_LIBRE'
  }
}

async function classifyDireccion(userMessage, businessId = null) {
  try {
    const response = await groqCall({
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
    await logAiCall(businessId, 'classifyDireccion', response)
    return response.choices[0].message.content.trim().toUpperCase()
  } catch {
    return 'PREGUNTA_LIBRE'
  }
}

async function extractAddress(userMessage, businessId = null) {
  try {
    const response = await groqCall({
      model: 'llama-3.1-8b-instant',
      max_tokens: 60,
      messages: [
        {
          role: 'system',
          content: `Eres un extractor de direcciones de entrega.
REGLAS ABSOLUTAS:
1. Extrae ÚNICAMENTE la dirección completa incluyendo: calle, número, barrio, sector, referencias adicionales si las hay.
2. Devuelve SOLO la dirección limpia, sin puntos finales, sin comillas, sin explicación, sin palabras extra.
3. Ejemplos:
   - "quiero corregirla era calle 35#3 este 20 barrio villa brazil" → Calle 35#3 Este 20 Barrio Villa Brazil
   - "mi dirección es carrera 10 #20-30 apto 301 barrio centro" → Carrera 10 #20-30 Apto 301 Barrio Centro
4. NUNCA recortes el barrio, sector, apto, piso ni referencias.
5. NUNCA devuelvas frases como "la dirección es..." o "aquí está...".
6. Si no encuentras ninguna dirección, devuelve: NONE`
        },
        { role: 'user', content: userMessage }
      ]
    })
    await logAiCall(businessId, 'extractAddress', response)
    const result = response.choices[0].message.content.trim()
    return result === 'NONE' ? null : result
  } catch {
    return null
  }
}

async function extractOrderItems(userMessage, menuItems, businessId = null) {
  try {
    const menuList = menuItems.map(p => `- "${p.name}"`).join('\n')
    const response = await groqCall({
      model: 'llama-3.1-8b-instant',
      max_tokens: 300,
      messages: [
        {
          role: 'system',
          content: `Eres un mapeador de pedidos. Tu único trabajo es relacionar lo que el cliente escribió con el nombre exacto del producto en el menú, aunque esté mal escrito o abreviado.
REGLAS ABSOLUTAS:
1. SOLO puedes usar nombres que existan exactamente en el menú proporcionado.
2. NUNCA devuelvas un producto que no esté en el menú.
3. Si no puedes mapear algo con certeza, ignóralo.
4. Devuelve ÚNICAMENTE el JSON sin ningún texto adicional.`
        },
        {
          role: 'user',
          content: `Menú disponible:\n${menuList}\n\nMensaje del cliente: "${userMessage}"\n\nResponde ÚNICAMENTE con este JSON:\n{"items":[{"producto":"nombre exacto del menú","cantidad":1}]}\n\nSi no encuentras ningún producto válido: {"items":[]}`
        }
      ]
    })
    await logAiCall(businessId, 'extractOrderItems', response)
    const raw = response.choices[0].message.content.trim()
    const clean = raw.replace(/```json|```/g, '').trim()
    return JSON.parse(clean)
  } catch {
    return { items: [] }
  }
}

async function isValidAddress(userMessage, businessId = null) {
  try {
    const response = await groqCall({
      model: 'llama-3.1-8b-instant',
      max_tokens: 10,
      messages: [
        { role: 'system', content: 'Eres un validador de direcciones. Responde "SI" si el texto parece una dirección de entrega. Responde "NO" si es un comentario, duda o saludo.' },
        { role: 'user', content: `¿Es esto una dirección?: "${userMessage}"` }
      ]
    })
    await logAiCall(businessId, 'isValidAddress', response)
    return response.choices[0].message.content.trim().toUpperCase().includes('SI')
  } catch {
    return false
  }
}

async function generateFreeResponse(businessContext, userMessage, currentState = null, stateData = null, businessId = null) {
  try {
    const stateDescriptions = {
      'MENU_ENVIADO': 'El cliente acaba de recibir el menú. SOLO responde si pregunta algo específico del menú como ingredientes o alergias. Si dice que quiere algo, responde: "¡Dime qué quieres y lo anoto! 😊"',
      'ARMANDO_PEDIDO': `El cliente está armando su pedido. Carrito actual: ${stateData?.items?.length > 0 ? stateData.items.map(i => `${i.quantity}x ${i.name}`).join(', ') : 'vacío'}. SOLO confirma lo que hay en el carrito si pregunta. No sugieras productos.`,
      'ESPERANDO_DIRECCION': 'El cliente debe dar su dirección. SOLO dile que escriba su dirección de entrega. Nada más.',
      'ESPERANDO_PAGO': `El cliente debe enviar el comprobante. Total: $${(stateData?.total || 0).toLocaleString('es-CO')}. SOLO recuérdale que envíe la foto del comprobante.`,
      'VALIDANDO_PAGO': 'El pago está en verificación. SOLO dile que espere la confirmación. Máximo 1 línea.',
      'EN_PREPARACION': 'El pedido está en cocina. SOLO dile que está siendo preparado y el tiempo estimado es 25-35 min.',
      'EN_CAMINO': 'El pedido va en camino. SOLO dile que el domiciliario ya va hacia allá.',
      'ENTREGADO': 'El pedido fue entregado. Pregúntale si quiere hacer otro pedido.',
      'CONFIRMANDO_DIRECCION': 'El cliente está confirmando su dirección. SOLO pregúntale si confirma o quiere corregirla.'
    }

    const stateContext = stateDescriptions[currentState] || 'Responde brevemente y redirige al flujo de pedido.'

    const response = await groqCall({
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
        { role: 'user', content: userMessage }
      ]
    })
    await logAiCall(businessId, 'generateFreeResponse', response)
    return response.choices[0].message.content.trim()
  } catch {
    return 'En este momento tengo problemas técnicos. Por favor escríbenos en un momento 🙏'
  }
}

module.exports = { classifyIntent, extractOrderItems, generateFreeResponse, isValidAddress, classifyDireccion, extractAddress }