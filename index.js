const {Telegraf} = require('telegraf');
const {GoogleGenAI} = require('@google/genai');
require('dotenv').config();
const fs = require('fs').promises;
const path = require('path');

const express = require('express');
const app = express();
const PORT = process.env.PORT || 3000;

app.get('/', (req, res) => res.send('Бот работает!'));
app.listen(PORT, () => console.log(`Слушаем порт ${PORT}`));

// Проверяем наличие обязательных переменных окружения
if (!process.env.TELEGRAM_BOT_TOKEN || !process.env.GEMINI_API_KEY) {
    console.error('Ошибка: Переменные окружения TELEGRAM_BOT_TOKEN или GEMINI_API_KEY не заданы в .env');
    process.exit(1);
}

// Инициализация Telegram-бота и Gemini API
const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);
const ai = new GoogleGenAI({apiKey: process.env.GEMINI_API_KEY});

// Команда /start
bot.start((ctx) => {
    ctx.reply('Привет! Я бот на базе Gemini. Отправь мне любой текстовый запрос, и я постараюсь ответить!');
});

// Функция логирования диалога в markdown файл
async function logToMarkdown(chatId, username, userMsg, botMsg) {
    const logPath = path.join(__dirname, 'chat_history.md');
    const timestamp = new Date().toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' });
    const logEntry = `### Сообщение от ${timestamp}
- **ID Чата**: \`${chatId}\`
- **Пользователь**: @${username || 'не указан'}
- **Запрос**: ${userMsg}
- **Ответ бота**: ${botMsg}

---

`;
    try {
        await fs.appendFile(logPath, logEntry, 'utf8');
    } catch (err) {
        console.error('Ошибка при записи лога в файл:', err);
    }
}

// Обработка входящих текстовых сообщений
bot.on('text', async (ctx) => {
    try {
        // Включаем статус "печатает..." в Telegram для лучшего UX
        await ctx.sendChatAction('typing');

        const userMessage = ctx.message.text;

        // Запрос к Gemini API (используем быструю и эффективную модель gemini-2.5-flash)
        const response = await ai.models.generateContent({
            model: 'gemini-2.5-flash',
            contents: userMessage,
            config: {
                systemInstruction: `Ты — умный и преданный личный помощник пользователя. Твоя задача — помогать ему во всех личных и рабочих делах, организовывать задачи, давать полезные советы и поддерживать порядок в делах.
Веди себя профессионально, но дружелюбно, участливо, вежливо и с заботой.
Всегда отвечай строго в формате JSON.
Твой ответ должен содержать:
1. "text" — подробный текстовый ответ на русском языке.
2. "reaction" — один эмодзи-реакция для сообщения пользователя (выбери подходящий из: 👍, 👎, ❤️, 🔥, 🥰, 👏, 😁, 🤔, 🤯, 😱, 😢, 🎉, 🙏, 👌, 👀, 🤣, 💯) либо пустая строка, если реакция не уместна.
3. "imageKeyword" — если пользователь явно просит прислать или показать картинку/изображение, укажи здесь краткий поисковый запрос для картинки на английском языке (1-3 слова), иначе укажи пустую строку.`,
                responseMimeType: 'application/json',
                responseSchema: {
                    type: 'object',
                    properties: {
                        text: { type: 'string' },
                        reaction: { type: 'string' },
                        imageKeyword: { type: 'string' }
                    },
                    required: ['text', 'reaction', 'imageKeyword']
                }
            }
        });

        // Отправляем ответ пользователю
        if (response && response.text) {
            let responseObj;
            try {
                responseObj = JSON.parse(response.text);
            } catch (jsonErr) {
                console.error('Ошибка парсинга JSON от Gemini:', jsonErr);
                // На случай сбоя парсинга используем текст напрямую
                responseObj = { text: response.text, reaction: '', imageKeyword: '' };
            }

            // Отправляем текстовый ответ
            await ctx.reply(responseObj.text);

            // Ставим реакцию на сообщение пользователя
            if (responseObj.reaction && responseObj.reaction.trim()) {
                const reactionEmoji = responseObj.reaction.trim();
                try {
                    await ctx.react(reactionEmoji);
                } catch (reactError) {
                    console.error('Не удалось установить реакцию:', reactError);
                }
            }

            // Отправляем фото, если найден поисковый запрос для картинки
            if (responseObj.imageKeyword && responseObj.imageKeyword.trim()) {
                const keyword = responseObj.imageKeyword.trim();
                const photoUrl = `https://loremflickr.com/800/600/${encodeURIComponent(keyword)}`;
                try {
                    await ctx.replyWithPhoto(photoUrl, {
                        caption: `Вот изображение по вашему запросу: "${keyword}"`
                    });
                } catch (photoError) {
                    console.error('Не удалось отправить фото:', photoError);
                }
            }

            // Записываем контекст диалога в файл
            await logToMarkdown(ctx.chat.id, ctx.from.username, userMessage, responseObj.text);
        } else {
            await ctx.reply('Мне не удалось сформулировать ответ. Попробуйте еще раз.');
        }

    } catch (error) {
        console.error('Ошибка при обработке сообщения:', error);
        await ctx.reply('Произошла ошибка при обработке вашего запроса. Пожалуйста, попробуйте позже.');
    }
});

// Запуск бота
bot.launch()
    .then(() => console.log('🚀 Бот успешно запущен и готов к работе!'))
    .catch((err) => console.error('Ошибка запуска бота:', err));

// Корректная остановка бота при завершении процесса сервера
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('TERM', () => bot.stop('TERM'));