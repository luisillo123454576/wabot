const supabase = require('./supabase')
const { extractOrderItems } = require('./ai')

// Normalizar texto: minúsculas, sin tildes, sin signos
function normalizeText(text) {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, '')
    .trim()
}

// Filtro 0: detectar "lo mismo de ayer"
const REPEAT_TRIGGERS = [
  'lo mismo',
  'lo de siempre',
  'lo mismo de ayer',
  'repite',
  'igual que antes',
  'lo mismo que la vez pasada',
  'lo mismo que antes',
  'repite el pedido'
]

async function detectRepeatOrder(customerId) {
  const { data: lastOrder } = await supabase
    .from('orders')
    .select('*')
    .eq('customer_id', customerId)
    .eq('state', 'ENTREGADO')
    .order('created_at', { ascending: false })
    .limit(1)
    .single()

  return lastOrder || null
}

// Filtro 1: detectar por aliases sin IA
async function detectByAlias(userMessage, businessId) {
  const normalized = normalizeText(userMessage)

  const { data: products } = await supabase
    .from('products')
    .select('*')
    .eq('business_id', businessId)
    .eq('is_available', true)

  if (!products || products.length === 0) return null

  const found = []

  for (const product of products) {
    const aliases = product.aliases || []
    const allTerms = [
      normalizeText(product.name),
      ...aliases.map(a => normalizeText(a))
    ]

    for (const term of allTerms) {
      if (normalized.includes(term)) {
        // Detectar cantidad cerca del término encontrado
        const termIndex = normalized.indexOf(term)
        const surrounding = normalized.substring(Math.max(0, termIndex - 10), termIndex + term.length + 10)
        const quantityMatch = surrounding.match(/(\d+)/)
        const quantity = quantityMatch ? parseInt(quantityMatch[1]) : 1

        found.push({ product, quantity })
        break // evita duplicar el mismo producto por múltiples aliases
      }
    }
  }

  return found.length > 0 ? found : null
}
// Filtro 2: extraer con IA cuando alias no encuentra nada
async function detectByAI(userMessage, businessId) {
  const { extractOrderItems } = require('./ai')

  const { data: products } = await supabase
    .from('products')
    .select('*')
    .eq('business_id', businessId)
    .eq('is_available', true)

  if (!products || products.length === 0) return null

  const extracted = await extractOrderItems(userMessage, products)

  if (!extracted.items || extracted.items.length === 0) return null

  const results = []
  for (const item of extracted.items) {
    if (!item.producto) continue
    const match = products.find(p =>
      normalizeText(p.name) === normalizeText(item.producto)
    )
    if (match) {
      results.push({ product: match, quantity: item.cantidad || 1 })
    }
  }

  return results.length > 0 ? results : null
}

async function detectOrderItems(userMessage, businessId, customerId) {
  const normalized = normalizeText(userMessage)

  // Filtro 0: ¿es "lo mismo de ayer"?
  const isRepeat = REPEAT_TRIGGERS.some(trigger =>
    normalized.includes(normalizeText(trigger))
  )

  if (isRepeat) {
    const lastOrder = await detectRepeatOrder(customerId)
    if (lastOrder) {
      return { type: 'REPEAT', items: lastOrder.items, total: lastOrder.total }
    } else {
      return { type: 'NO_PREVIOUS_ORDER' }
    }
  }

  // Filtro 1: detección por alias
const byAlias = await detectByAlias(userMessage, businessId)
if (byAlias) {
  return {
    type: 'FOUND',
    products: byAlias
  }
}

// Filtro 2: extracción por IA
const byAI = await detectByAI(userMessage, businessId)
if (byAI) {
  return {
    type: 'FOUND',
    products: byAI
  }
}

  return { type: 'NOT_FOUND' }
}

module.exports = { detectOrderItems, normalizeText }