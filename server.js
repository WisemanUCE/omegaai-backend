require('dotenv').config();
const express = require('express');
const axios = require('axios');
const bodyParser = require('body-parser');
const cors = require('cors');

const app = express();
const port = process.env.PORT || 3000;  // ✅ Use Render-assigned port

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

app.use(cors());
app.use(bodyParser.json());

// ✅ Add root route for health check
app.get('/', (req, res) => {
    res.send('✅ OmegaAI backend is running!');
});

app.post('/chat', async (req, res) => {
    const userMessage = req.body.message;

    try {
        const response = await axios.post(
            'https://api.openai.com/v1/chat/completions',
            {
                model: 'gpt-3.5-turbo',
                messages: [{ role: 'user', content: userMessage }]
            },
            {
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${OPENAI_API_KEY}`
                }
            }
        );

        const aiReply = response.data.choices[0].message.content;
        res.json({ reply: aiReply });
    } catch (error) {
        console.error('Error communicating with OpenAI:', error.response?.data || error.message);
        res.status(500).json({ error: 'Error communicating with OpenAI' });
    }
});

app.listen(port, () => {
    console.log(`✅ OmegaAI proxy server running on port ${port}`);
});
