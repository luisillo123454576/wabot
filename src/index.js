const express = require('express')
const dotenv = require('dotenv')

dotenv.config()

const supabase = require('./services/supabase')

const app = express()
app.use(express.json())
const webhookRouter = require('./routes/webhook')
app.use('/webhook', webhookRouter)
app.get('/', (req, res) => {
  res.json({ status: 'wabot platform running' })
})

const PORT = process.env.PORT || 3000
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`)
})