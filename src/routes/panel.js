const { Router } = require('express')
const router = Router()
const supabase = require('../services/supabase')

// GET /api/panel/stats
router.get('/stats', async (req, res) => {
  const businessId = req.query.business_id

  const { count: totalOrders } = await supabase
    .from('orders')
    .select('*', { count: 'exact', head: true })
    .eq('business_id', businessId)

  const { count: activeOrders } = await supabase
    .from('orders')
    .select('*', { count: 'exact', head: true })
    .eq('business_id', businessId)
    .in('state', ['EN_PREPARACION', 'EN_CAMINO'])

  const { count: totalCustomers } = await supabase
    .from('customers')
    .select('*', { count: 'exact', head: true })
    .eq('business_id', businessId)

  const today = new Date()
  today.setHours(0, 0, 0, 0)

  const { data: todayOrders } = await supabase
    .from('orders')
    .select('total')
    .eq('business_id', businessId)
    .eq('state', 'ENTREGADO')
    .gte('created_at', today.toISOString())

  const todayRevenue = todayOrders?.reduce((acc, o) => acc + o.total, 0) || 0

  res.json({ totalOrders, activeOrders, totalCustomers, todayRevenue })
})

// GET /api/panel/orders
router.get('/orders', async (req, res) => {
  const { business_id, state } = req.query

  let query = supabase
    .from('orders')
    .select('*, customers(phone_number, name)')
    .eq('business_id', business_id)
    .order('created_at', { ascending: false })

  if (state) query = query.eq('state', state)

  const { data, error } = await query
  if (error) return res.status(500).json({ error })
  res.json(data)
})

// PATCH /api/panel/orders/:id/state
router.patch('/orders/:id/state', async (req, res) => {
  const { id } = req.params
  const { state } = req.body

  const { error } = await supabase
    .from('orders')
    .update({ state })
    .eq('id', id)

  if (error) return res.status(500).json({ error })
  res.json({ success: true })
})

// GET /api/panel/chats
router.get('/chats', async (req, res) => {
  const { business_id } = req.query

  const { data, error } = await supabase
    .from('customers')
    .select('*')
    .eq('business_id', business_id)
    .order('last_activity', { ascending: false })

  if (error) return res.status(500).json({ error })
  res.json(data)
})

// GET /api/panel/business
router.get('/business', async (req, res) => {
  const { business_id } = req.query

  const { data, error } = await supabase
    .from('businesses')
    .select('*, products(*)')
    .eq('id', business_id)
    .single()

  if (error) return res.status(500).json({ error })
  res.json(data)
})

// PATCH /api/panel/business
router.patch('/business', async (req, res) => {
  const { business_id, ...updates } = req.body

  const { error } = await supabase
    .from('businesses')
    .update(updates)
    .eq('id', business_id)

  if (error) return res.status(500).json({ error })
  res.json({ success: true })
})

// GET /api/panel/customers
router.get('/customers', async (req, res) => {
  const { business_id } = req.query

  const { data, error } = await supabase
    .from('customers')
    .select('*')
    .eq('business_id', business_id)
    .order('created_at', { ascending: false })

  if (error) return res.status(500).json({ error })
  res.json(data)
})

module.exports = router