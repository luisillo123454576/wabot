const supabase = require('../services/supabase')
const { classifyIntent, generateFreeResponse } = require('../services/ai')
const { detectOrderItems } = require('../services/messageDetector')

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
  return products.map(p => `• ${p.name} — $${Number(p.price).toLocaleString('es-CO')}`).join('\n')
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
    `¡Hola! Bienvenido a *${business.name}* 👋\n\nAquí te dejamos nuestro menú:\n\n${menu}\n\n¿Qué te provoca pedir hoy?`,
    `¡Buenas! Gracias por escribirnos a *${business.name}* 😄\n\nEsto es lo que tenemos:\n\n${menu}\n\n¿Qué vas a querer?`,
    `¡Hola! En *${business.name}* estamos para servirte 🙌\n\nNuestro menú:\n\n${menu}\n\n¿Qué se te antoja?`
  ])

  await sendMessage(customer.phone_number, greeting)
  await updateCustomerState(customer.id, 'MENU_ENVIADO')
}

async function handleMenuEnviado(customer, business, userMessage, sendMessage) {
  const intent = await classifyIntent('MENU_ENVIADO', userMessage)

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
    const reply = await generateFreeResponse(business.ai_context, userMessage, customer.state, customer.state_data)
    await sendMessage(customer.phone_number, reply)
    return
  }

  await sendMessage(customer.phone_number,
    pickRandom([
      '¿Qué deseas pedir? 😊',
      '¿Qué te provoca hoy?',
      'Dime qué vas a querer y te ayudo 🙌'
    ])
  )
}

async function handleArmandoPedido(customer, business, userMessage, sendMessage) {
  const stateData = customer.state_data || { items: [] }
  const currentItems = stateData.items || []

  const intent = await classifyIntent('ARMANDO_PEDIDO', userMessage)

  if (intent === 'CANCELAR') {
    await updateCustomerState(customer.id, 'CANCELADO', { reason: 'cliente canceló', cancelled_by: 'cliente' })
    await sendMessage(customer.phone_number,
      pickRandom([
        'Listo, cancelé tu pedido. Cuando quieras volver a pedir aquí estamos 😊',
        'Pedido cancelado. ¡Vuelve cuando quieras! 👋'
      ])
    )
    await updateCustomerState(customer.id, 'NUEVO', {})
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
    const { product, quantity } = result
    const subtotal = product.price * quantity

    // Verificar si el producto ya está en el carrito
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

    await updateCustomerState(customer.id, 'ARMANDO_PEDIDO', { items: currentItems })

    const summary = formatCart(currentItems)
    await sendMessage(customer.phone_number,
      pickRandom([
        `✅ Listo, agregué ${quantity}x ${product.name}.\n\n${summary}\n\n¿Algo más o confirmamos?`,
        `✅ Perfecto, ${quantity}x ${product.name} al pedido.\n\n${summary}\n\n¿Agregamos algo más?`,
        `✅ Ya tengo ${quantity}x ${product.name}.\n\n${summary}\n\n¿Seguimos o lo confirmamos?`
      ])
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
  const text = userMessage.trim();

  // SCORE HEURÍSTICO (sin IA)
  const addressRegex = /(calle|cll|cl|carrera|cra|cr|diagonal|dg|transversal|tv|avenida|av|barrio|br|mz|manzana|casa|lote|sector|apto|piso|este|oeste|norte|sur)\s?\d+|[#\-\d]{3,}/i;

  let score = 0;
  if (addressRegex.test(text)) score += 60;
  if (text.length > 12) score += 20;
  if (/\d+/.test(text)) score += 20;

  // IA solo si hay duda (score medio)
  let esDireccionReal = false;
  if (score >= 80) {
    esDireccionReal = true;
  } else if (score >= 20) {
    esDireccionReal = await isValidAddress(text);
  }

  if (esDireccionReal) {
    const stateData = customer.state_data || { items: [] };
    const items = stateData.items || [];
    const subtotal = items.reduce((acc, i) => acc + i.subtotal, 0);
    const totalFinal = subtotal + 3000;

    const { data: order } = await supabase
      .from('orders')
      .insert({
        business_id: business.id,
        customer_id: customer.id,
        items,
        total: totalFinal,
        delivery_address: text,
        state: 'PENDIENTE'
      })
      .select().single();

    await updateCustomerState(customer.id, 'ESPERANDO_PAGO', {
      order_id: order.id,
      items,
      total: totalFinal,
      address: text
    });

    await sendMessage(customer.phone_number,
      `Direccion guardada: ${text}\n\n` +
      `Resumen:\n${formatCart(items)}\n` +
      `Domicilio: $3.000\n` +
      `TOTAL: $${totalFinal.toLocaleString('es-CO')}\n\n` +
      `Paga por Nequi: ${business.payment_info || '3235949088'}\n` +
      `Envia el comprobante para confirmar.`
    );
  } else {
    const reply = await generateFreeResponse(business.ai_context, text, customer.state, customer.state_data);
    await sendMessage(customer.phone_number, reply);
  }
}
async function handleEsperandoPago(customer, business, userMessage, hasMedia, sendMessage) {
  const intent = await classifyIntent('ESPERANDO_PAGO', userMessage)

  if (intent === 'CANCELAR') {
    await updateCustomerState(customer.id, 'NUEVO', {})
    await sendMessage(customer.phone_number, 'Pedido cancelado. ¡Cuando quieras volvemos! 👋')
    return
  }

  // Detectar el comprobante (imagen)
  if (hasMedia || intent === 'ENVIO_COMPROBANTE') {
    const stateData = customer.state_data || {}

    await supabase
      .from('orders')
      .update({ state: 'VALIDANDO_PAGO', payment_proof: 'recibido' })
      .eq('id', stateData.order_id)

    await updateCustomerState(customer.id, 'VALIDANDO_PAGO')

    // Notificar al dueño con lujo de detalles
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

  await sendMessage(customer.phone_number,
    `Aún espero el comprobante por *$${(customer.state_data?.total || 0).toLocaleString('es-CO')}*. 📲\n\nRecuerda enviarlo como *imagen* (captura de pantalla).`
  )
}
async function handleValidandoPago(customer, business, userMessage, sendMessage) {
  // Esta función la llama el webhook cuando detecta que el mensaje viene del dueño
  const normalized = userMessage.toLowerCase().trim()

  const stateData = customer.state_data || {}

  if (normalized.includes('confirmar')) {
    await supabase
      .from('orders')
      .update({ state: 'CONFIRMADO' })
      .eq('id', stateData.order_id)

    await updateCustomerState(customer.id, 'PEDIDO_CONFIRMADO')

    await sendMessage(customer.phone_number,
      pickRandom([
        '✅ ¡Pago confirmado! Tu pedido está en preparación 🍔 Tiempo estimado: 25-35 min.',
        '✅ ¡Listo! Pago recibido, ya estamos preparando tu pedido 🔥 En 25-35 min está contigo.'
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
  const reply = await generateFreeResponse(business.ai_context, userMessage, customer.state, customer.state_data)
  await sendMessage(customer.phone_number, reply);
}

async function handleEnCamino(customer, business, userMessage, sendMessage) {
  // El cliente escribió mientras el repartidor va hacia allá.
  // NO usamos updateCustomerState. Solo respondemos con IA.
  const reply = await generateFreeResponse(business.ai_context, userMessage, customer.state, customer.state_data)
  await sendMessage(customer.phone_number, reply);
}

async function handleEntregado(customer, business, userMessage, sendMessage) {
  // Ya se entregó, pero si el cliente dice "gracias" o "estaba rico", 
  // respondemos amablemente sin mandarle el menú todavía.
  const intent = await classifyIntent('ENTREGADO', userMessage);
  
  if (intent === 'HACER_PEDIDO') {
      await handleNuevo(customer, business, sendMessage);
  } else {
      const reply = await generateFreeResponse(business.ai_context, userMessage, customer.state, customer.state_data)
      await sendMessage(customer.phone_number, reply);
  }
}
// ─── ESTADOS GLOBALES ─────────────────────────────────────────────────────────

async function handleAtencionInteligente(customer, business, userMessage, sendMessage) {
  const reply = await generateFreeResponse(business.ai_context, userMessage, customer.state, customer.state_data)
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
  
  // --- 1. FILTRO DE SEGURIDAD: CLASIFICAR ANTES DE ACTUAR ---
  const intent = await classifyIntent(state, userMessage);

  // Si el cliente quiere CANCELAR o ver el MENU, no importa en qué estado esté,
  // le hacemos caso al comando, no a la IA.
  if (intent === 'CANCELAR') {
      await updateCustomerState(customer.id, 'NUEVO', {});
      return await sendMessage(customer.phone_number, "Pedido cancelado. ¿En qué puedo ayudarte ahora?");
  }
  
  if (intent === 'VER_MENU' && state !== 'NUEVO') {
      return await handleNuevo(customer, business, sendMessage);
  }

  // --- 2. EL SWITCH DE ESTADOS ---
  switch (state) {
    case 'NUEVO':
      await handleNuevo(customer, business, sendMessage)
      break

    case 'MENU_ENVIADO':
    case 'ARMANDO_PEDIDO':
      // Si la intención es PREGUNTA_LIBRE, usamos IA. 
      // Si es HACER_PEDIDO, usamos la lógica de productos.
      if (intent === 'PREGUNTA_LIBRE') {
          const reply = await generateFreeResponse(business.ai_context, userMessage, state, customer.state_data);
          await sendMessage(customer.phone_number, reply);
      } else {
          await handleArmandoPedido(customer, business, userMessage, sendMessage);
      }
      break

    case 'ESPERANDO_PAGO':
      // Solo si manda foto o dice que ya pagó
      if (hasMedia || intent === 'ENVIO_COMPROBANTE') {
          await handleEsperandoPago(customer, business, userMessage, hasMedia, sendMessage);
      } else {
          // Si solo está preguntando "¿dónde pago?", responde la IA cortico
          const reply = await generateFreeResponse(business.ai_context, userMessage, state, customer.state_data);
          await sendMessage(customer.phone_number, reply);
      }
      break

    case 'VALIDANDO_PAGO':
      // El nombre de la variable aquí debe ser igual al de abajo
      const reply = await generateFreeResponse(business.ai_context, userMessage, customer.state, customer.state_data);
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
  handleErrorFlujo
}