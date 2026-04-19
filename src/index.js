const express = require('express')
const dotenv = require('dotenv')

dotenv.config()

const supabase = require('./services/supabase')

const app = express()

// CORS
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*')
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS')
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization')
  if (req.method === 'OPTIONS') return res.sendStatus(200)
  next()
})

app.use(express.json())

const webhookRouter = require('./routes/webhook')
const panelRouter = require('./routes/panel')

app.use('/webhook', webhookRouter)
app.use('/api/panel', panelRouter)

app.get('/', (req, res) => {
  res.json({ status: 'wabot platform running' })
})

const PORT = process.env.PORT || 3000
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`)
})