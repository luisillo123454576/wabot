const supabase = require('../services/supabase')
const { classifyIntent, generateFreeResponse, isValidAddress, classifyDireccion, extractAddress, interpretCartModification } = require('../services/ai')
const { detectOrderItems, normalizeText } = require('../services/messageDetector')
// ─── UTILIDADES ───────────────────────────────────────────────────────────────

async function updateCustomerState(customerId, newState, stateData = null, savePrevious = false) {
  const updates = {
    state: newState,
    last_activity: new Date().toISOString()
  }

  if (stateData !== null) updates.state_data = stateData
  if (savePrevious) {
    const { data: current } = await supabase
      .from('customers')
      .select('state')
      .eq('id', customerId)
      .single()
    if (current) updates.previous_state = current.state
  }

  await supabase
    .from('customers')
    .update(updates)
    .eq('id', customerId)
}

function formatMenu(products) {
  if (!products || products.length === 0) return 'No hay productos disponibles.'
  return products.map(p => `${p.emoji || '•'} ${p.name} — $${Number(p.price).toLocaleString('es-CO')}`).join('\n')
}

function formatCart(items) {
  if (!items || items.length === 0) return 'Tu carrito está vacío.'
  
  // Solo devuelve las líneas de los productos
  const lines = items.map(i => `• ${i.quantity}x ${i.name} — $${Number(i.subtotal).toLocaleString('es-CO')}`)
  
  return lines.join('\n') // Ya no agregamos la línea del "Total" aquí
}

// Variación de respuestas para sonar natural
function pickRandom(options) {
  return options[Math.floor(Math.random() * options.length)]
}

// ─── ESTADOS PRINCIPALES ──────────────────────────────────────────────────────

async function handleNuevo(customer, business, sendMessage) {
  const { data: products } = await supabase
    .from('products')
    .select('*')
    .eq('business_id', business.id)
    .eq('is_available', true)

  const menu = formatMenu(products)

  const greeting = pickRandom([
  `🍽️ *${business.name}*\n\n¡Hola! Bienvenido 👋\n\n🔥 *Menú:*\n\n${menu}\n\n_Dime qué quieres y lo anoto_ 😊`,
  `👋 ¡Buenas! Gracias por escribirnos a *${business.name}*\n\n📋 *Lo que tenemos:*\n\n${menu}\n\n¿Qué vas a querer?`,
  `¡Hola! En *${business.name}* estamos para servirte 🙌\n\n✨ *Menú:*\n\n${menu}\n\n¿Qué se te antoja?`
])

  await sendMessage(customer.phone_number, greeting)
  await updateCustomerState(customer.id, 'MENU_ENVIADO')
}

async function handleMenuEnviado(customer, business, userMessage, sendMessage) {
  const intent = await classifyIntent('MENU_ENVIADO', userMessage, business.id)

  if (intent === 'VER_MENU') {
    const { data: products } = await supabase
      .from('products')
      .select('*')
      .eq('business_id', business.id)
      .eq('is_available', true)

    const menu = formatMenu(products)
    await sendMessage(customer.phone_number, `Claro, aquí está nuestro menú:\n\n${menu}\n\n¿Qué vas a querer?`)
    return
  }

  if (intent === 'HACER_PEDIDO' || intent === 'REPETIR_PEDIDO') {
    await updateCustomerState(customer.id, 'ARMANDO_PEDIDO', { items: [] })
    await handleArmandoPedido(customer, business, userMessage, sendMessage)
    return
  }

  if (intent === 'PREGUNTA_LIBRE') {
   const prepTime = `${business.prep_time_min ?? 25}-${business.prep_time_max ?? 35} min`
   const reply = await generateFreeResponse(business.ai_context, userMessage, customer.state, customer.state_data, business.id, prepTime)
    await sendMessage(customer.phone_number, reply)
    return
  }

  // Fallback — intentar detectar productos directamente
  await updateCustomerState(customer.id, 'ARMANDO_PEDIDO', { items: [] })
  const updatedCustomer = { ...customer, state: 'ARMANDO_PEDIDO', state_data: { items: [] } }
  await handleArmandoPedido(updatedCustomer, business, userMessage, sendMessage)
}
async function handleModificarCarrito(customer, business, userMessage, currentItems, sendMessage) {
  if (currentItems.length === 0) {
    await sendMessage(customer.phone_number, 'Tu carrito está vacío. ¿Qué quieres pedir?')
    return
  }

  // Pedirle a la IA que interprete la modificación en contexto del carrito actual
  const cartSummary = currentItems.map(i => `- ${i.quantity}x ${i.name} (id: ${i.product_id})`).join('\n')
  
  let modification
  try {
    const { default: Groq } = await import('groq-sdk').catch(() => ({ default: require('groq-sdk') }))
    const groq = new (require('groq-sdk'))({ apiKey: process.env.GROQ_API_KEY })
    
    const response = await groq.chat.completions.create({
      model: 'llama-3.1-8b-instant',
      max_tokens: 200,
      messages: [
        {
          role: 'system',
          content: `Eres un intérprete de modificaciones de carrito. 
El cliente tiene un carrito con productos y quiere hacer un cambio.
Tu trabajo: identificar qué product_ids quitar y qué productos nuevos agregar.
Responde ÚNICAMENTE con JSON, sin texto adicional:
{"remove": ["product_id_1", "product_id_2"], "add": [{"name": "nombre exacto del producto nuevo", "quantity": 1}]}
Si no hay nada que quitar: "remove": []
Si no hay nada que agregar: "add": []`
        },
        {
          role: 'user',
          content: `Carrito actual:\n${cartSummary}\n\nMensaje del cliente: "${userMessage}"\n\n¿Qué quitar y qué agregar?`
        }
      ]
    })

    const raw = response.choices[0].message.content.trim()
    const clean = raw.replace(/```json|```/g, '').trim()
    modification = JSON.parse(clean)
  } catch (err) {
    console.error('Error interpretando modificación:', err.message)
    const summary = formatCart(currentItems)
    await sendMessage(customer.phone_number,
      `No entendí bien qué querías cambiar. Tu pedido actual:\n\n${summary}\n\n¿Qué quieres quitar o cambiar?`
    )
    return
  }

  const { remove = [], add = [] } = modification

  // Caso borde: IA no detectó nada
  if (remove.length === 0 && add.length === 0) {
    const summary = formatCart(currentItems)
    await sendMessage(customer.phone_number,
      `No entendí bien qué querías cambiar. Tu pedido actual:\n\n${summary}\n\n¿Qué quieres quitar o cambiar?`
    )
    return
  }

  // Aplicar remociones
  let updatedItems = currentItems.filter(i => !remove.includes(i.product_id))

  // Aplicar adiciones — resolver nombre a producto real
  if (add.length > 0) {
    const { data: products } = await supabase
      .from('products')
      .select('*')
      .eq('business_id', business.id)
      .eq('is_available', true)

    for (const { name, quantity } of add) {
      const match = products.find(p =>
        normalizeText(p.name) === normalizeText(name)
      )
      if (!match) continue
      const existingIndex = updatedItems.findIndex(i => i.product_id === match.id)
      if (existingIndex >= 0) {
        updatedItems[existingIndex].quantity += quantity
        updatedItems[existingIndex].subtotal += match.price * quantity
      } else {
        updatedItems.push({
          product_id: match.id,
          name: match.name,
          quantity,
          price: match.price,
          subtotal: match.price * quantity
        })
      }
    }
  }

  await updateCustomerState(customer.id, 'ARMANDO_PEDIDO', { items: updatedItems })

  if (updatedItems.length === 0) {
    await sendMessage(customer.phone_number,
      '✅ Listo, eliminé eso. Tu carrito quedó vacío. ¿Qué quieres pedir?'
    )
    return
  }

  const summary = formatCart(updatedItems)
  await sendMessage(customer.phone_number,
    `✅ Actualizado. Tu pedido ahora:\n\n${summary}\n\n¿Algo más o confirmamos?`
  )
}
async function handleArmandoPedido(customer, business, userMessage, sendMessage) {
  const stateData = customer.state_data || { items: [] }
  const currentItems = stateData.items || []

  const intent = await classifyIntent('ARMANDO_PEDIDO', userMessage, business.id)

  if (intent === 'CANCELAR') {
    await updateCustomerState(customer.id, 'NUEVO', {})
    await sendMessage(customer.phone_number, pickRandom([
      'Listo, cancelé tu pedido. Cuando quieras volver a pedir aquí estamos 😊',
      'Pedido cancelado. ¡Vuelve cuando quieras! 👋'
    ]))
    return
  }

  if (intent === 'MODIFICAR_CARRITO') {
    await handleModificarCarrito(customer, business, userMessage, currentItems, sendMessage)
    return
  }

  if (intent === 'CONFIRMAR') {
    if (currentItems.length === 0) {
      await sendMessage(customer.phone_number, 'Aún no has agregado nada al pedido. ¿Qué deseas pedir?')
      return
    }
    await updateCustomerState(customer.id, 'ESPERANDO_DIRECCION')
    const summary = formatCart(currentItems)
    await sendMessage(customer.phone_number,
      `Perfecto, tu pedido es:\n\n${summary}\n\n¿A qué dirección te lo enviamos?`
    )
    return
  }

  if (intent === 'REPETIR_PEDIDO') {
    const result = await detectOrderItems(userMessage, business.id, customer.id)
    if (result.type === 'REPEAT') {
      await updateCustomerState(customer.id, 'ARMANDO_PEDIDO', { items: result.items })
      const summary = formatCart(result.items)
      await sendMessage(customer.phone_number,
        `Cargué tu pedido anterior:\n\n${summary}\n\n¿Lo confirmamos o quieres cambiar algo?`
      )
      return
    }
    if (result.type === 'NO_PREVIOUS_ORDER') {
      await sendMessage(customer.phone_number, 'No encontré pedidos anteriores. ¿Qué deseas pedir hoy?')
      return
    }
  }

  // Detectar ítem del pedido
  const result = await detectOrderItems(userMessage, business.id, customer.id)

  if (result.type === 'FOUND') {
    for (const { product, quantity } of result.products) {
      const subtotal = product.price * quantity
      const existingIndex = currentItems.findIndex(i => i.product_id === product.id)
      if (existingIndex >= 0) {
        currentItems[existingIndex].quantity += quantity
        currentItems[existingIndex].subtotal += subtotal
      } else {
        currentItems.push({
          product_id: product.id,
          name: product.name,
          quantity,
          price: product.price,
          subtotal
        })
      }
    }
    await updateCustomerState(customer.id, 'ARMANDO_PEDIDO', { items: currentItems })
    const summary = formatCart(currentItems)
    await sendMessage(customer.phone_number,
      pickRandom([
        `✅ Listo, agregué los productos.\n\n${summary}\n\n¿Algo más o confirmamos?`,
        `✅ Perfecto, ya tengo todo anotado.\n\n${summary}\n\n¿Agregamos algo más?`,
        `✅ Anotado.\n\n${summary}\n\n¿Seguimos o lo confirmamos?`
      ])
    )
    return
  }

  if (result.type === 'AMBIGUOUS') {
    const optionsList = result.options.map((p, i) =>
      `${i + 1}. ${p.name} — $${Number(p.price).toLocaleString('es-CO')}`
    ).join('\n')
    await sendMessage(customer.phone_number,
      `¿Cuál de estas quieres? (${result.quantity} unidades)\n\n${optionsList}\n\nEscríbeme el nombre exacto o el número 😊`
    )
    return
  }

  if (result.type === 'NOT_FOUND') {
    const { data: products } = await supabase
      .from('products')
      .select('*')
      .eq('business_id', business.id)
      .eq('is_available', true)
    const menu = formatMenu(products)
    await sendMessage(customer.phone_number,
      `No entendí bien qué querías pedir. Aquí está el menú:\n\n${menu}\n\n¿Qué te llevo?`
    )
  }
}
async function handleEsperandoDireccion(customer, business, userMessage, sendMessage) {
  const text = userMessage.trim()

  // ── Detectar si quiere agregar productos ──────────────────────────────────
  const result = await detectOrderItems(text, business.id, customer.id)
  if (result.type === 'FOUND') {
    const currentItems = customer.state_data?.items || []
    for (const { product, quantity } of result.products) {
      const subtotal = product.price * quantity
      const existingIndex = currentItems.findIndex(i => i.product_id === product.id)
      if (existingIndex >= 0) {
        currentItems[existingIndex].quantity += quantity
        currentItems[existingIndex].subtotal += subtotal
      } else {
        currentItems.push({ product_id: product.id, name: product.name, quantity, price: product.price, subtotal })
      }
    }
    await updateCustomerState(customer.id, 'ARMANDO_PEDIDO', { items: currentItems })
    const summary = formatCart(currentItems)
    await sendMessage(customer.phone_number,
      `✅ Agregado. Tu pedido actualizado:\n\n${summary}\n\n¿Algo más o confirmamos?`
    )
    return
  }
  // ─────────────────────────────────────────────────────────────────────────

  const addressRegex = /(calle|cll|cl|carrera|cra|cr|diagonal|dg|transversal|tv|avenida|av|barrio|br|mz|manzana|casa|lote|sector|apto|piso|este|oeste|norte|sur)\s?\d+|[#\-\d]{3,}/i
  let score = 0
  if (addressRegex.test(text)) score += 60
  if (text.length > 12) score += 20
  if (/\d+/.test(text)) score += 20

  let esDireccion = false
  if (score >= 80) {
    esDireccion = true
  } else if (score >= 20) {
    esDireccion = await isValidAddress(text, business.id)
  }

  if (esDireccion) {
    const cleanAddress = await extractAddress(text) || text
    await updateCustomerState(customer.id, 'CONFIRMANDO_DIRECCION', {
      ...customer.state_data,
      pending_address: cleanAddress
    })
    await sendMessage(customer.phone_number,
      `📍 Dirección anotada: *${cleanAddress}*\n\n¿La confirmamos o quieres corregirla?`
    )
  } else {
    const prepTime = `${business.prep_time_min ?? 25}-${business.prep_time_max ?? 35} min`
    const reply = await generateFreeResponse(business.ai_context, userMessage, customer.state, customer.state_data, business.id, prepTime)
    await sendMessage(customer.phone_number, reply)
    await sendMessage(customer.phone_number, '📍 Cuando estés listo, escríbeme tu dirección de entrega.')
  }
}
async function handleConfirmandoDireccion(customer, business, userMessage, sendMessage) {
  const text = userMessage.trim()
  const stateData = customer.state_data || {}

  // ── Regex de confirmación ──────────────────────────────────────────────────
  const confirmRegex = /^(si|sí|s[ií]|yes|dale|listo|correcto|ok|okay|confirmad[ao]|así es|exacto|confirm[ao])$/i
  const isConfirmByRegex = confirmRegex.test(text.toLowerCase())

  // ── Regex de nueva dirección ───────────────────────────────────────────────
  const addressRegex = /(calle|cll|cl|carrera|cra|cr|diagonal|dg|transversal|tv|avenida|av|barrio|br|mz|manzana|casa|lote|sector|apto|piso|este|oeste|norte|sur)\s?\d+|[#\-\d]{3,}/i
  let addressScore = 0
  if (addressRegex.test(text)) addressScore += 60
  if (text.length > 12) addressScore += 20
  if (/\d+/.test(text)) addressScore += 20
  const isNewAddress = addressScore >= 60

  let action = null
if (isConfirmByRegex) {
    action = 'CONFIRMAR'
  } else if (isNewAddress) {
    action = 'NUEVA_DIRECCION'
  } else {
    action = await classifyDireccion(text)
  }

  if (action === 'CONFIRMAR') {
    await guardarDireccionYPasar(customer, business, stateData.pending_address, sendMessage)
    return
  }

  if (action === 'NUEVA_DIRECCION') {
    // Volver a ESPERANDO_DIRECCION con el nuevo texto
    const updatedCustomer = { ...customer, state: 'ESPERANDO_DIRECCION' }
    await updateCustomerState(customer.id, 'ESPERANDO_DIRECCION', { ...stateData, pending_address: null })
    await handleEsperandoDireccion(updatedCustomer, business, text, sendMessage)
    return
  }

  // PREGUNTA_LIBRE — IA responde y redirige
  const reply = await generateFreeResponse(business.ai_context, text, customer.state, stateData, business.id)
  await sendMessage(customer.phone_number, reply)
  await sendMessage(customer.phone_number,
    `📍 Dirección anotada: *${stateData.pending_address}*\n\n¿La confirmamos o quieres corregirla?`
  )
}

async function guardarDireccionYPasar(customer, business, address, sendMessage) {
  const stateData = customer.state_data || {}
  const items = stateData.items || []
  const subtotal = items.reduce((acc, i) => acc + i.subtotal, 0)
  const deliveryFee = business.delivery_fee ?? 3000
  const totalFinal = subtotal + deliveryFee

  const { data: order } = await supabase
    .from('orders')
    .insert({
      business_id: business.id,
      customer_id: customer.id,
      items,
      total: totalFinal,
      delivery_address: address,
      state: 'PENDIENTE'
    })
    .select().single()

  await updateCustomerState(customer.id, 'ESPERANDO_PAGO', {
    order_id: order.id,
    items,
    total: totalFinal,
    address
  })

  await sendMessage(customer.phone_number,
    `📍 Dirección confirmada: ${address}\n\n` +
    `Resumen:\n${formatCart(items)}\n` +
    `Domicilio: $${deliveryFee.toLocaleString('es-CO')}\n` +
    `TOTAL: $${totalFinal.toLocaleString('es-CO')}\n\n` +
    `Paga por: ${business.payment_info || 'Nequi 3235949088'}\n\n` +
    `Envía el comprobante para confirmar. 📸`
  )
}
async function handleEsperandoPago(customer, business, userMessage, hasMedia, sendMessage) {
  const intent = await classifyIntent('ESPERANDO_PAGO', userMessage)
  const msgLower = userMessage.toLowerCase()

  if (intent === 'CANCELAR') {
    await updateCustomerState(customer.id, 'NUEVO', {})
    await sendMessage(customer.phone_number, 'Pedido cancelado. ¡Cuando quieras volvemos! 👋')
    return
  }

  // Cliente manda comprobante (imagen)
  if (hasMedia || intent === 'ENVIO_COMPROBANTE') {
    const stateData = customer.state_data || {}

    await supabase
      .from('orders')
      .update({ state: 'VALIDANDO_PAGO', payment_proof: 'recibido' })
      .eq('id', stateData.order_id)

    await updateCustomerState(customer.id, 'VALIDANDO_PAGO')

    const summary = formatCart(stateData.items || [])
    await sendMessage(business.owner_phone,
      `🔔 *NUEVO COMPROBANTE RECIBIDO*\n\n` +
      `👤 Cliente: +${customer.phone_number}\n` +
      `📍 Dirección: ${stateData.address || 'No especificada'}\n` +
      `🛍️ Pedido:\n${summary}\n` +
      `💰 Total a verificar: $${(stateData.total || 0).toLocaleString('es-CO')}\n\n` +
      `Responde *confirmar* o *rechazar*`
    )

    await sendMessage(customer.phone_number,
      '✅ ¡Recibido! Estamos verificando tu pago. En un momento te confirmamos... ⏳'
    )
    return
  }

  // Cliente quiere pagar en efectivo
  if (intent === 'PAGO_EFECTIVO') {
    const stateData = customer.state_data || {}

    await supabase
      .from('orders')
      .update({ state: 'CONFIRMADO', payment_method: 'EFECTIVO' })
      .eq('id', stateData.order_id)

    await updateCustomerState(customer.id, 'EN_PREPARACION')

    const summary = formatCart(stateData.items || [])
    await sendMessage(business.owner_phone,
      `🔔 *NUEVO PEDIDO — PAGO EN EFECTIVO*\n\n` +
      `👤 Cliente: +${customer.phone_number}\n` +
      `📍 Dirección: ${stateData.address || 'No especificada'}\n` +
      `🛍️ Pedido:\n${summary}\n` +
      `💰 Total a cobrar en puerta: $${(stateData.total || 0).toLocaleString('es-CO')}\n\n` +
      `Responde *en camino* cuando salga el domiciliario.`
    )

    await sendMessage(customer.phone_number,
     `✅ ¡Listo! Tu pedido está confirmado. Pagas $${(stateData.total || 0).toLocaleString('es-CO')} en efectivo cuando llegue el domiciliario 💵\n\nEstamos preparando tu pedido 🍔 Tiempo estimado: ${business.prep_time_min ?? 25}-${business.prep_time_max ?? 35} min.`
    )
    return
  }

  // Cliente menciona Nequi pero no ha mandado comprobante aún
  if (msgLower.includes('nequi') || msgLower.includes('transferencia') || msgLower.includes('voy a pagar') || msgLower.includes('voy a transferir')) {
    await sendMessage(customer.phone_number,
      `Perfecto 👍 Cuando hagas el pago al 💳 *${business.payment_info}* envíanos la captura de pantalla como comprobante 📲`
    )
    return
  }

  // Cliente pregunta por otros métodos de pago
  if (msgLower.includes('bancolombia') || msgLower.includes('daviplata') || msgLower.includes('pse') || 
      msgLower.includes('tarjeta') || msgLower.includes('credito') || msgLower.includes('debito') ||
      msgLower.includes('otro') || msgLower.includes('metodo') || msgLower.includes('como pago') ||
      msgLower.includes('formas de pago') || msgLower.includes('aceptan')) {
    await sendMessage(customer.phone_number,
      `Por el momento solo manejamos:\n\n💳 *${business.payment_info}* *Efectivo* — pagas cuando llega el domiciliario\n\n¿Con cuál te queda mejor?`
    )
    return
  }

  // Cualquier otra pregunta — IA con contexto estricto de pago
  await sendMessage(customer.phone_number,
    `Recuerda que puedes pagar por:\n\n💳 *${business.payment_info}* (envía el comprobante como imagen)\n💵 *Efectivo* — pagas cuando llega el domiciliario\n\n¿Cuál prefieres?`
  )
}
async function handleValidandoPago(customer, business, userMessage, sendMessage) {
  const normalized = userMessage.toLowerCase().trim()
  const stateData = customer.state_data || {}

  if (normalized.includes('confirmar')) {
    const { error: orderError } = await supabase
      .from('orders')
      .update({ state: 'CONFIRMADO' })
      .eq('id', stateData.order_id)

    
    const { error: customerError } = await supabase
      .from('customers')
      .update({ state: 'EN_PREPARACION', last_activity: new Date().toISOString() })
      .eq('id', customer.id)

    

    await sendMessage(customer.phone_number,
      pickRandom([
        `✅ ¡Listo! Pago recibido, ya estamos preparando tu pedido 🔥 En ${business.prep_time_min ?? 25}-${business.prep_time_max ?? 35} min está contigo.`
      ])
    )
    return
  }

  if (normalized.includes('rechazar')) {
    await supabase
      .from('orders')
      .update({ state: 'PAGO_RECHAZADO' })
      .eq('id', stateData.order_id)

    await updateCustomerState(customer.id, 'ESPERANDO_PAGO')

    await sendMessage(customer.phone_number,
      'Hubo un problema con tu comprobante de pago 😕 ¿Puedes enviarlo de nuevo?'
    )
  }
}
async function handleEnPreparacion(customer, business, userMessage, sendMessage) {
  // El cliente escribió mientras cocinan. 
  // NO usamos updateCustomerState. Solo respondemos con IA.
  const prepTime = `${business.prep_time_min ?? 25}-${business.prep_time_max ?? 35} min`
  const reply = await generateFreeResponse(business.ai_context, userMessage, customer.state, customer.state_data, business.id, prepTime)
  await sendMessage(customer.phone_number, reply);
}

async function handleEnCamino(customer, business, userMessage, sendMessage) {
  // El cliente escribió mientras el repartidor va hacia allá.
  // NO usamos updateCustomerState. Solo respondemos con IA.
  const prepTime = `${business.prep_time_min ?? 25}-${business.prep_time_max ?? 35} min`
  const reply = await generateFreeResponse(business.ai_context, userMessage, customer.state, customer.state_data, business.id, prepTime)
  await sendMessage(customer.phone_number, reply);
}

async function handleEntregado(customer, business, userMessage, sendMessage) {
  // Ya se entregó, pero si el cliente dice "gracias" o "estaba rico", 
  // respondemos amablemente sin mandarle el menú todavía.
  const intent = await classifyIntent('ENTREGADO', userMessage, business.id)
  
  if (intent === 'HACER_PEDIDO') {
      await handleNuevo(customer, business, sendMessage);
  } else {
      const prepTime = `${business.prep_time_min ?? 25}-${business.prep_time_max ?? 35} min`
      const reply = await generateFreeResponse(business.ai_context, userMessage, customer.state, customer.state_data, business.id, prepTime)
      await sendMessage(customer.phone_number, reply);
  }
}
// ─── ESTADOS GLOBALES ─────────────────────────────────────────────────────────

async function handleAtencionInteligente(customer, business, userMessage, sendMessage) {
  const prepTime = `${business.prep_time_min ?? 25}-${business.prep_time_max ?? 35} min`
  const reply = await generateFreeResponse(business.ai_context, userMessage, customer.state, customer.state_data, business.id, prepTime)
  await sendMessage(customer.phone_number, reply)
  // Regresar al estado anterior
  if (customer.previous_state) {
    await updateCustomerState(customer.id, customer.previous_state)
  }
}

async function handleInactivoTimeout(customer, business, sendMessage, level) {
  if (level === '5min') {
    await sendMessage(customer.phone_number,
      pickRandom([
        '¿Sigues ahí? 😊 ¿Te ayudo con algo?',
        '¡Hola! ¿Continuamos con tu pedido? 🙌'
      ])
    )
    return
  }

  if (level === '30min') {
    await sendMessage(customer.phone_number,
      '¿Todavía quieres hacer tu pedido? Si necesitas ayuda aquí estamos 😊'
    )
    return
  }

  if (level === '2h') {
    await updateCustomerState(customer.id, 'NUEVO', {})
    await sendMessage(customer.phone_number,
      'Tu sesión expiró por inactividad. Cuando quieras volver a pedir escríbenos 👋'
    )
  }
}

async function handleErrorFlujo(customer, business, sendMessage) {
  await sendMessage(customer.phone_number,
    pickRandom([
      'No entendí bien, ¿me repites? 😊',
      '¿Puedes escribirlo de otra forma? No te entendí bien.',
      'Disculpa, no capté eso. ¿Me lo repites?'
    ])
  )
}

// ─── ROUTER PRINCIPAL ─────────────────────────────────────────────────────────

async function handleState(customer, business, userMessage, hasMedia, sendMessage) {
  const state = customer.state || 'NUEVO'
  
  if (state === 'NUEVO') {
    return await handleNuevo(customer, business, sendMessage)
  }
  
  if (state === 'ESPERANDO_DIRECCION') {
    return await handleEsperandoDireccion(customer, business, userMessage, sendMessage)
  }

  const intent = await classifyIntent(state, userMessage, business.id)

const NO_REDIRIGIR_MENU = ['NUEVO', 'EN_PREPARACION', 'EN_CAMINO', 'VALIDANDO_PAGO', 'ESPERANDO_PAGO', 'CONFIRMANDO_DIRECCION', 'ENTREGADO']
const NO_CANCELAR = ['EN_PREPARACION', 'EN_CAMINO', 'VALIDANDO_PAGO', 'ENTREGADO', 'CONFIRMANDO_DIRECCION']

if (intent === 'CANCELAR' && !NO_CANCELAR.includes(state)) {
  const result = await detectOrderItems(userMessage, business.id, customer.id)
  if (result.type === 'FOUND' || result.type === 'AMBIGUOUS') {
    const currentItems = customer.state_data?.items || []
    await handleModificarCarrito(customer, business, userMessage, currentItems, sendMessage)
    return
  }
  await updateCustomerState(customer.id, 'NUEVO', {})
  return await sendMessage(customer.phone_number, 'Pedido cancelado. ¿En qué puedo ayudarte ahora?')
}

if (intent === 'VER_MENU' && !NO_REDIRIGIR_MENU.includes(state)) {
  return await handleNuevo(customer, business, sendMessage)
}
  // --- 2. EL SWITCH DE ESTADOS ---
  switch (state) {
  case 'NUEVO':
    await handleNuevo(customer, business, sendMessage)
    break

  case 'MENU_ENVIADO':
    if (intent === 'PREGUNTA_LIBRE') {
      const prepTime = `${business.prep_time_min ?? 25}-${business.prep_time_max ?? 35} min`
      const reply = await generateFreeResponse(business.ai_context, userMessage, customer.state, customer.state_data, business.id, prepTime)
      await sendMessage(customer.phone_number, reply)
    } else {
      await handleMenuEnviado(customer, business, userMessage, sendMessage)
    }
    break
  
  case 'ARMANDO_PEDIDO':
    // Aquí la IA NO responde preguntas libres
    // Todo mensaje se intenta interpretar como producto
    // Si no reconoce nada, handleArmandoPedido muestra el menú y pregunta de nuevo
    await handleArmandoPedido(customer, business, userMessage, sendMessage)
    break
  case 'CONFIRMANDO_DIRECCION':
  await handleConfirmandoDireccion(customer, business, userMessage, sendMessage)
  break
    case 'ESPERANDO_PAGO': {
  const esEfectivo = (() => {
    const msg = userMessage.toLowerCase()
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    
    const frasesDirectas = [
      'pago en efectivo', 'pagar en efectivo', 'pagare en efectivo',
      'pago al llegar', 'pago contra entrega', 'pago cuando llegue',
      'en efectivo', 'con efectivo', 'cash',
      'pago en la puerta', 'pago ahi', 'pago aqui',
      'lo pago ahi', 'lo pago aqui', 'te pago ahi', 'te pago aqui',
      'pago a la entrega', 'efectivo por favor', 'con billetes'
    ]
    if (frasesDirectas.some(f => msg.includes(f))) return true

    const verboPago = /(pago|pagare|pagaré|pagar|cancelo|cancelaré|abono)/.test(msg)
    const contextoPago = /(casa|puerta|ahi|aqui|llegue|llegues|entrega|domicilio|llegar|momento)/.test(msg)
    return verboPago && contextoPago
  })()

  if (esEfectivo || intent === 'PAGO_EFECTIVO') {
    const stateData = customer.state_data || {}
    await supabase
      .from('orders')
      .update({ state: 'CONFIRMADO', payment_method: 'EFECTIVO' })
      .eq('id', stateData.order_id)
    await updateCustomerState(customer.id, 'EN_PREPARACION')
    const summary = formatCart(stateData.items || [])
    await sendMessage(business.owner_phone,
      `🔔 *NUEVO PEDIDO — PAGO EN EFECTIVO*\n\n` +
      `👤 Cliente: +${customer.phone_number}\n` +
      `📍 Dirección: ${stateData.address || 'No especificada'}\n` +
      `🛍️ Pedido:\n${summary}\n` +
      `💰 Total a cobrar en puerta: $${(stateData.total || 0).toLocaleString('es-CO')}\n\n` +
      `Responde *en camino* cuando salga el domiciliario.`
    )
    await sendMessage(customer.phone_number,
      `✅ ¡Listo! Tu pedido está confirmado. Pagas $${(stateData.total || 0).toLocaleString('es-CO')} en efectivo cuando llegue el domiciliario 💵\n\nEstamos preparando tu pedido 🍔 Tiempo estimado: 25-35 min.`
    )
    return
  }

  await handleEsperandoPago(customer, business, userMessage, hasMedia, sendMessage)
  break
}
    case 'VALIDANDO_PAGO':
      // El nombre de la variable aquí debe ser igual al de abajo
      const reply = await generateFreeResponse(business.ai_context, userMessage, customer.state, customer.state_data, business.id)
      await sendMessage(customer.phone_number, reply); // <--- Aquí quítale el "Validando"
      break

    case 'PEDIDO_CONFIRMADO':
    case 'EN_PREPARACION':
      // Ambos estados ahora usan la función que creamos para cuando están cocinando
      await handleEnPreparacion(customer, business, userMessage, sendMessage)
      break

    case 'EN_CAMINO':
      await handleEnCamino(customer, business, userMessage, sendMessage)
      break

    case 'ENTREGADO':
      // Usamos la función inteligente que evita el menú automático
      await handleEntregado(customer, business, userMessage, sendMessage)
      break

    case 'CANCELADO':
      await updateCustomerState(customer.id, 'NUEVO', {})
      await handleNuevo(customer, business, sendMessage)
      break

    case 'ATENCION_INTELIGENTE':
      await handleAtencionInteligente(customer, business, userMessage, sendMessage)
      break

    case 'HUMANO_INTERVIENE':
      await sendMessage(customer.phone_number,
        'Un momento, te estoy conectando con nuestro equipo 🙏'
      )
     break

    default:
      await handleErrorFlujo(customer, business, sendMessage)
  }
}

module.exports = {
  handleState,
  handleInactivoTimeout,
  handleErrorFlujo,
  handleValidandoPago
}