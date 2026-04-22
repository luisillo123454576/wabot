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
function wordsToNumbers(text) {
  const map = {
    'un ': '1 ', 'una ': '1 ', 'uno ': '1 ',
    'dos ': '2 ', 'tres ': '3 ', 'cuatro ': '4 ',
    'cinco ': '5 ', 'seis ': '6 ', 'siete ': '7 ',
    'ocho ': '8 ', 'nueve ': '9 ', 'diez ': '10 '
  }
  let result = text
  for (const [word, num] of Object.entries(map)) {
    result = result.replace(new RegExp(word, 'gi'), num)
  }
  return result
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
  const normalizedWithNums = wordsToNumbers(normalized + ' ')

  const { data: products } = await supabase
    .from('products').select('*')
    .eq('business_id', businessId).eq('is_available', true)

  if (!products || products.length === 0) return null

  const found = []
  for (const product of products) {
    const aliases = product.aliases || []
    const allTerms = [normalizeText(product.name), ...aliases.map(a => normalizeText(a))]

    for (const term of allTerms) {
      const idx = normalizedWithNums.indexOf(term)
      if (idx === -1) continue

      // Buscar cantidad ANTES y DESPUÉS del término (rango más amplio)
      const before = normalizedWithNums.substring(Math.max(0, idx - 15), idx)
      const after = normalizedWithNums.substring(idx + term.length, idx + term.length + 10)
      const surrounding = before + after

      const quantityMatch = surrounding.match(/(\d+)/)
      const quantity = quantityMatch ? parseInt(quantityMatch[1]) : 1

      found.push({ product, quantity })
      break
    }
  }
  return found.length > 0 ? found : null
}
// Filtro 2: extraer con IA cuando alias no encuentra nada
async function detectByAI(userMessage, businessId) {
  const { extractOrderItems } = require('./ai')
  const messageWithNums = wordsToNumbers(normalizeText(userMessage))  // ← agregar

  const { data: products } = await supabase
    .from('products')
    .select('*')
    .eq('business_id', businessId)
    .eq('is_available', true)

  if (!products || products.length === 0) return null

  const extracted = await extractOrderItems(messageWithNums, products) 

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
function detectAmbiguity(products, userMessage) {
  const normalized = normalizeText(userMessage)
  const withNums = wordsToNumbers(normalized + ' ')

  // Agrupar productos por término base compartido
  const groups = {}
  for (const { product, quantity } of products) {
    const name = normalizeText(product.name)
    // Buscar si hay otro producto que contenga el mismo término base
    for (const { product: other } of products) {
      if (product.id === other.id) continue
      const otherName = normalizeText(other.name)
      // Si comparten palabra base (ej: "hamburguesa")
      const words = name.split(' ').filter(w => w.length > 4)
      for (const word of words) {
        if (otherName.includes(word)) {
          const key = word
          if (!groups[key]) groups[key] = { options: [], quantity }
          if (!groups[key].options.find(p => p.id === product.id)) groups[key].options.push(product)
          if (!groups[key].options.find(p => p.id === other.id)) groups[key].options.push(other)
        }
      }
    }
  }

  const ambiguousGroup = Object.values(groups)[0]
  return ambiguousGroup && ambiguousGroup.options.length > 1 ? ambiguousGroup : null
}
async function detectOrderItems(userMessage, businessId, customerId) {
  const normalized = normalizeText(userMessage)

  const isRepeat = REPEAT_TRIGGERS.some(trigger =>
    normalized.includes(normalizeText(trigger))
  )
  if (isRepeat) {
    const lastOrder = await detectRepeatOrder(customerId)
    if (lastOrder) return { type: 'REPEAT', items: lastOrder.items, total: lastOrder.total }
    return { type: 'NO_PREVIOUS_ORDER' }
  }

  const byAlias = await detectByAlias(userMessage, businessId)
  if (byAlias) {
    // Detectar ambigüedad — mismo término matcheó múltiples productos
    const ambiguous = detectAmbiguity(byAlias, userMessage)
    if (ambiguous) return { type: 'AMBIGUOUS', options: ambiguous.options, quantity: ambiguous.quantity }
    return { type: 'FOUND', products: byAlias }
  }

  const byAI = await detectByAI(userMessage, businessId)
  if (byAI) {
    const ambiguous = detectAmbiguity(byAI, userMessage)
    if (ambiguous) return { type: 'AMBIGUOUS', options: ambiguous.options, quantity: ambiguous.quantity }
    return { type: 'FOUND', products: byAI }
  }

  return { type: 'NOT_FOUND' }
}

module.exports = { detectOrderItems, normalizeText }