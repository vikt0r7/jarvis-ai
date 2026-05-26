const {Telegraf} = require('telegraf');
const {GoogleGenAI} = require('@google/genai');
require('dotenv').config();

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

// Обработка входящих текстовых сообщений
bot.on('text', async (ctx) => {
    try {
        // Включаем статус "печатает..." в Telegram для лучшего UX
        await ctx.sendChatAction('typing');

        const userMessage = ctx.message.text;

        // Запрос к Gemini API (используем быструю и эффективную модель gemini-2.5-flash)
        const response = await ai.models.generateContent({
            model: 'gemini-2.5-flash', contents: userMessage,
        });

        // Отправляем ответ пользователю
        if (response && response.text) {
            await ctx.reply(response.text);
        } else {
            await ctx.reply('Мне не удалось сформулировать ответ. Попробуйте еще раз.');
        }

    } catch (error) {
        console.error('Ошибка при обращении к Gemini API:', error);
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