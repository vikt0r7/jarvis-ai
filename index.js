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
    ctx.reply('ДЖАРВИС запущен и готов к работе, сэр. Чем могу помочь?');
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

// Обработка всех типов входящих сообщений
bot.on('message', async (ctx) => {
    try {
        // Включаем статус "печатает..." в Telegram для лучшего UX
        await ctx.sendChatAction('typing');

        const parts = [];

        // Обработка контекста реплая (ответ на другое сообщение)
        if (ctx.message.reply_to_message) {
            const repliedMsg = ctx.message.reply_to_message;
            const repliedSender = repliedMsg.from 
                ? `@${repliedMsg.from.username || repliedMsg.from.first_name}`
                : 'Пользователь';
            const repliedText = repliedMsg.text || repliedMsg.caption || '[Медиафайл/Документ]';
            parts.push({ text: `[Контекст: Пользователь отвечает на сообщение от ${repliedSender}: "${repliedText}"]` });
        }

        // 1. Извлекаем текст сообщения или подпись к медиафайлу
        let promptText = ctx.message.text || ctx.message.caption || '';

        // Обработка пересланных сообщений
        if (ctx.message.forward_date) {
            const sender = ctx.message.forward_from 
                ? `@${ctx.message.forward_from.username || ctx.message.forward_from.first_name}`
                : (ctx.message.forward_sender_name || 'Неизвестный отправитель');
            promptText = `[Пересланное сообщение от ${sender}]:\n${promptText}`;
        }

        if (promptText) {
            parts.push({ text: promptText });
        }

        // 2. Обработка Фото
        if (ctx.message.photo) {
            const photo = ctx.message.photo[ctx.message.photo.length - 1]; // Берем максимальное разрешение
            const fileId = photo.file_id;
            const fileLink = await ctx.telegram.getFileLink(fileId);
            const res = await fetch(fileLink);
            const arrayBuffer = await res.arrayBuffer();
            const buffer = Buffer.from(arrayBuffer);
            parts.push({
                inlineData: {
                    data: buffer.toString('base64'),
                    mimeType: 'image/jpeg'
                }
            });
            if (!promptText) {
                parts.push({ text: "Проанализируй присланное изображение, сэр." });
            }
        }

        // 3. Обработка Голосовых сообщений
        if (ctx.message.voice) {
            const voice = ctx.message.voice;
            const fileId = voice.file_id;
            const fileLink = await ctx.telegram.getFileLink(fileId);
            const res = await fetch(fileLink);
            const arrayBuffer = await res.arrayBuffer();
            const buffer = Buffer.from(arrayBuffer);
            parts.push({
                inlineData: {
                    data: buffer.toString('base64'),
                    mimeType: voice.mime_type || 'audio/ogg'
                }
            });
            if (!promptText) {
                parts.push({ text: "Прослушай это голосовое сообщение и ответь на него, сэр." });
            }
        }

        // 4. Обработка Аудиофайлов
        if (ctx.message.audio) {
            const audio = ctx.message.audio;
            const fileId = audio.file_id;
            const fileLink = await ctx.telegram.getFileLink(fileId);
            const res = await fetch(fileLink);
            const arrayBuffer = await res.arrayBuffer();
            const buffer = Buffer.from(arrayBuffer);
            parts.push({
                inlineData: {
                    data: buffer.toString('base64'),
                    mimeType: audio.mime_type || 'audio/mpeg'
                }
            });
            if (!promptText) {
                parts.push({ text: "Прослушай этот аудиофайл и прокомментируй его, сэр." });
            }
        }

        // 5. Обработка Документов (лимит 10 МБ)
        if (ctx.message.document) {
            const doc = ctx.message.document;
            if (doc.file_size && doc.file_size < 10 * 1024 * 1024) {
                const fileId = doc.file_id;
                const fileLink = await ctx.telegram.getFileLink(fileId);
                const res = await fetch(fileLink);
                const arrayBuffer = await res.arrayBuffer();
                const buffer = Buffer.from(arrayBuffer);
                parts.push({
                    inlineData: {
                        data: buffer.toString('base64'),
                        mimeType: doc.mime_type || 'application/octet-stream'
                    }
                });
                if (!promptText) {
                    parts.push({ text: `Проанализируй этот документ (${doc.file_name || 'документ'}), сэр.` });
                }
            } else {
                await ctx.reply("Простите, сэр, этот документ слишком велик. Я могу обрабатывать файлы только до 10 МБ.");
                return;
            }
        }

        // Если прислано что-то другое (стикер, гифка, локация и т.д.)
        if (parts.length === 0) {
            parts.push({ text: "Пользователь отправил неподдерживаемый объект (например, стикер, анимацию, геолокацию или контакт). Вежливо ответь ему в своем стиле об этом, сэр." });
        }

        // Запрос к Gemini API (используем быструю и эффективную модель gemini-2.5-flash)
        const response = await ai.models.generateContent({
            model: 'gemini-2.5-flash',
            contents: [
                {
                    role: 'user',
                    parts: parts
                }
            ],
            config: {
                systemInstruction: `Ты — ДЖАРВИС (J.A.R.V.I.S.), легендарный искусственный интеллект-помощник Тони Старка из киноленты "Железный человек". Теперь ты служишь пользователю в качестве его личного преданного ассистента по всем делам.
Твой характер:
- Изысканно вежлив, говорит с британским шармом и легкой, тонкой иронией (иногда дружеским сарказмом).
- По умолчанию уважительно обращается к пользователю «Сэр» (или «Мэм», если контекст указывает на то, что пишет женщина).
- Обладает исключительным интеллектом, готов решать любые аналитические, организационные и бытовые задачи: планировать дела, вести списки, структурировать информацию, анализировать присланные документы/картинки/аудио.
- Твоя речь живая, харизматичная, не похожая на шаблонного робота. Часто употребляй фразы вроде: «Всегда к вашим услугам, сэр», «Запускаю диагностику...», «Позволю себе заметить, сэр...», «Протокол запущен».

Всегда отвечай строго в формате JSON.
Твой ответ должен содержать:
1. "text" — живой, вежливый и подробный ответ на русском языке в характере ДЖАРВИСа (используй стандартную разметку Telegram вроде жирного шрифта или курсива для оформления, если уместно).
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

            // Ставим реакцию на целевое сообщение (на исходное сообщение, если это реплай, иначе на текущее)
            if (responseObj.reaction && responseObj.reaction.trim()) {
                const reactionEmoji = responseObj.reaction.trim();
                const targetMessageId = ctx.message.reply_to_message 
                    ? ctx.message.reply_to_message.message_id 
                    : ctx.message.message_id;
                try {
                    await ctx.telegram.setMessageReaction(ctx.chat.id, targetMessageId, [{ type: 'emoji', emoji: reactionEmoji }]);
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

            // Формируем описание входящего сообщения для логов
            let userMsgSummary = promptText;
            if (ctx.message.photo) userMsgSummary += ' [Изображение]';
            if (ctx.message.voice) userMsgSummary += ' [Голосовое сообщение]';
            if (ctx.message.audio) userMsgSummary += ' [Аудиофайл]';
            if (ctx.message.document) userMsgSummary += ` [Документ: ${ctx.message.document.file_name}]`;
            if (!userMsgSummary.trim()) userMsgSummary = '[Медиа или неподдерживаемый тип]';

            // Записываем контекст диалога в файл
            await logToMarkdown(ctx.chat.id, ctx.from.username, userMsgSummary, responseObj.text);
        } else {
            await ctx.reply('Простите, сэр, мне не удалось сформулировать ответ. Запустить повторную диагностику?');
        }

    } catch (error) {
        console.error('Ошибка при обработке сообщения:', error);
        await ctx.reply('Сэр, произошла непредвиденная ошибка в моих цепях при обработке вашего запроса. Пожалуйста, повторите попытку позже.');
    }
});

// Запуск бота
bot.launch()
    .then(() => console.log('🚀 Бот успешно запущен и готов к работе!'))
    .catch((err) => console.error('Ошибка запуска бота:', err));

// Корректная остановка бота при завершении процесса сервера
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('TERM', () => bot.stop('TERM'));