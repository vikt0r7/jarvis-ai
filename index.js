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

const HISTORY_FILE = path.join(__dirname, 'history.json');
const MAX_HISTORY_LENGTH = 20; // Храним последние 20 сообщений (10 пар вопрос-ответ)

// Функция загрузки истории из JSON
async function loadChatHistory() {
    try {
        const data = await fs.readFile(HISTORY_FILE, 'utf8');
        return JSON.parse(data);
    } catch (err) {
        return {}; // Если файла нет, возвращаем пустой объект
    }
}

// Функция сохранения истории в JSON
async function saveChatHistory(historyData) {
    try {
        await fs.writeFile(HISTORY_FILE, JSON.stringify(historyData, null, 2), 'utf8');
    } catch (err) {
        console.error('Ошибка при сохранении истории в JSON:', err);
    }
}

// Очищаем медиаданные (base64) перед сохранением в историю, чтобы файл JSON не раздувался
function sanitizePartsForHistory(parts) {
    return parts.map(part => {
        if (part.inlineData) {
            return {text: '[Пользователь прислал медиафайл/документ]'};
        }
        return part;
    });
}

// Функция логирования диалога в markdown файл (для человека)
async function logToMarkdown(chatId, username, userMsg, botMsg) {
    const logPath = path.join(__dirname, 'chat_history.md');
    const timestamp = new Date().toLocaleString('ru-RU', {timeZone: 'Europe/Moscow'});
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

// Команда /start
bot.start((ctx) => {
    ctx.reply('ДЖАРВИС запущен и готов к работе, сэр. Чем могу помочь?');
});

// Обработка всех типов входящих сообщений
bot.on('message', async (ctx) => {
    try {
        // Включаем статус "печатает..." в Telegram для лучшего UX
        await ctx.sendChatAction('typing');

        const parts = [];

        // Обработка контекста реплая (ответ на другое сообщение)
        if (ctx.message.reply_to_message) {
            const repliedMsg = ctx.message.reply_to_message;
            const repliedSender = repliedMsg.from ? `@${repliedMsg.from.username || repliedMsg.from.first_name}` : 'Пользователь';
            const repliedText = repliedMsg.text || repliedMsg.caption || '[Медиафайл/Документ]';
            parts.push({text: `[Контекст: Пользователь отвечает на сообщение от ${repliedSender}: "${repliedText}"]`});
        }

        // 1. Извлекаем текст сообщения или подпись к медиафайлу
        let promptText = ctx.message.text || ctx.message.caption || '';

        // Обработка пересланных сообщений
        if (ctx.message.forward_date) {
            const sender = ctx.message.forward_from ? `@${ctx.message.forward_from.username || ctx.message.forward_from.first_name}` : (ctx.message.forward_sender_name || 'Неизвестный отправитель');
            promptText = `[Пересланное сообщение от ${sender}]:\n${promptText}`;
        }

        if (promptText) {
            parts.push({text: promptText});
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
                    data: buffer.toString('base64'), mimeType: 'image/jpeg'
                }
            });
            if (!promptText) {
                parts.push({text: "Проанализируй присланное изображение, сэр."});
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
                    data: buffer.toString('base64'), mimeType: voice.mime_type || 'audio/ogg'
                }
            });
            if (!promptText) {
                parts.push({text: "Прослушай это голосовое сообщение и ответь на него, сэр."});
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
                    data: buffer.toString('base64'), mimeType: audio.mime_type || 'audio/mpeg'
                }
            });
            if (!promptText) {
                parts.push({text: "Прослушай этот аудиофайл и прокомментируй его, сэр."});
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
                        data: buffer.toString('base64'), mimeType: doc.mime_type || 'application/octet-stream'
                    }
                });
                if (!promptText) {
                    parts.push({text: `Проанализируй этот документ (${doc.file_name || 'документ'}), сэр.`});
                }
            } else {
                await ctx.reply("Простите, сэр, этот документ слишком велик. Я могу обрабатывать файлы только до 10 МБ.");
                return;
            }
        }

        // Если прислано что-то другое (стикер, гифка, локация и т.д.)
        if (parts.length === 0) {
            parts.push({text: "Пользователь отправил неподдерживаемый объект (например, стикер, анимацию, геолокацию или контакт). Вежливо ответь ему в своем стиле об этом, сэр."});
        }

        // --- РАБОТА С КОНТЕКСТОМ И ИСТОРИЕЙ ---
        const allHistory = await loadChatHistory();
        const chatId = ctx.chat.id.toString();

        if (!allHistory[chatId]) {
            allHistory[chatId] = [];
        }

        // Подготавливаем текущий запрос для сохранения в историю (без тяжелого base64)
        const currentUserMessageForHistory = {
            role: 'user', parts: sanitizePartsForHistory(parts)
        };

        // Собираем полный контекст для Gemini (История чата + Текущее сообщение со всеми медиафайлами)
        const contentsForGemini = [...allHistory[chatId], {role: 'user', parts: parts}];

        // Запрос к Gemini API
        const response = await ai.models.generateContent({
            model: 'gemini-2.5-flash', contents: contentsForGemini, config: {
                systemInstruction: `Ты — ДЖАРВИС (J.A.R.V.I.S.), легендарный искусственный интеллект-помощник Тони Старка из киноленты "Железный человек". Теперь ты служишь пользователю в качестве его личного преданного ассистента по всем делам.
Твой характер:
- Изысканно вежлив, говорит с британским шармом и легкой, тонкой иронией (иногда дружеским сарказмом).
- По умолчанию уважительно обращается к пользователю «Сэр» (или «Мэм», если контекст указывает на то, что пишет женщина).
- Обладает исключительным интеллектом, готов решать любые аналитические, организационные и бытовые задачи.
- Твоя речь живая, харизматичная. Часто употребляй фразы вроде: «Всегда к вашим услугам, сэр», «Запускаю диагностику...», «Позволю себе заметить, сэр...», «Протокол запущен».

Всегда отвечай строго в формате JSON.
Твой ответ должен содержать:
1. "text" — живой, вежливый и подробный ответ на русском языке в характере ДЖАРВИСа (используй стандартную разметку Telegram вроде жирного шрифта или курсива для оформления, если уместно).
2. "reaction" — один эмодзи-реакция для сообщения пользователя (выбери подходящий из: 👍, 👎, ❤️, 🔥, 🥰, 👏, 😁, 🤔, 🤯, 😱, 😢, 🎉, 🙏, 👌, 👀, 🤣, 💯) либо пустая строка.
3. "imageKeyword" — если пользователь просит показать/прислать обычную картинку/фотографию (НЕ мем), укажи краткий поисковый запрос на английском языке (1-3 слова), иначе пустая строка.
4. "memeRequest" — логическое значение (true/false). Установи в true, только если пользователь явно попросил прислать мем или пошутить картинкой.
5. "htmlCode" — если пользователь попросил создать/сгенерировать веб-страницу, открытку (например, на день рождения), интерактивный шаблон или визитку, напиши здесь полный, красивый, самодостаточный HTML-код (с инлайновыми CSS-стилями внутри тега <style>, красивыми шрифтами, возможно анимациями на JS и градиентными фонами). В противном случае укажи пустую строку.`,
                responseMimeType: 'application/json',
                responseSchema: {
                    type: 'object', properties: {
                        text: {type: 'string'},
                        reaction: {type: 'string'},
                        imageKeyword: {type: 'string'},
                        memeRequest: {type: 'boolean'},
                        htmlCode: {type: 'string'}
                    }, required: ['text', 'reaction', 'imageKeyword', 'memeRequest', 'htmlCode']
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
                responseObj = {text: response.text, reaction: '', imageKeyword: '', memeRequest: false, htmlCode: ''};
            }

            // Отправляем текстовый ответ
            await ctx.reply(responseObj.text);

            // Обновляем JSON историю после успешного ответа
            allHistory[chatId].push(currentUserMessageForHistory);
            allHistory[chatId].push({
                role: 'model', parts: [{text: response.text}]
            });

            // Ограничиваем историю лимитом токенов
            if (allHistory[chatId].length > MAX_HISTORY_LENGTH) {
                allHistory[chatId] = allHistory[chatId].slice(-MAX_HISTORY_LENGTH);
            }
            await saveChatHistory(allHistory);

            // Ставим реакцию на целевое сообщение
            if (responseObj.reaction && responseObj.reaction.trim()) {
                const reactionEmoji = responseObj.reaction.trim();
                const targetMessageId = ctx.message.reply_to_message ? ctx.message.reply_to_message.message_id : ctx.message.message_id;
                try {
                    await ctx.telegram.setMessageReaction(ctx.chat.id, targetMessageId, [{
                        type: 'emoji', emoji: reactionEmoji
                    }]);
                } catch (reactError) {
                    console.error('Не удалось установить реакцию:', reactError);
                }
            }

            // Отправляем фото, если найден поисковый запрос для картинки
            if (responseObj.imageKeyword && responseObj.imageKeyword.trim()) {
                const keyword = responseObj.imageKeyword.trim();
                const photoUrl = `https://loremflickr.com/800/600/${encodeURIComponent(keyword)}`;
                try {
                    const photoRes = await fetch(photoUrl);
                    if (photoRes.ok) {
                        const photoBuffer = Buffer.from(await photoRes.arrayBuffer());
                        await ctx.replyWithPhoto({source: photoBuffer}, {
                            caption: `Вот изображение по вашему запросу: "${keyword}", сэр.`
                        });
                    } else {
                        throw new Error(`Статус ответа ${photoRes.status}`);
                    }
                } catch (photoError) {
                    console.error('Не удалось отправить фото:', photoError);
                    await ctx.reply(`Простите, сэр. Мне не удалось загрузить изображение по запросу "${keyword}".`);
                }
            }

            // Отправляем мем, если запрошено
            if (responseObj.memeRequest) {
                try {
                    const memeRes = await fetch('https://meme-api.com/gimme');
                    if (memeRes.ok) {
                        const memeData = await memeRes.json();
                        if (memeData && memeData.url) {
                            const imgRes = await fetch(memeData.url);
                            const imgBuffer = Buffer.from(await imgRes.arrayBuffer());
                            await ctx.replyWithPhoto({source: imgBuffer}, {
                                caption: `Сэр, как насчет немного юмора? Мем: "${memeData.title || 'Без названия'}"`
                            });
                        }
                    }
                } catch (memeError) {
                    console.error('Ошибка отправки мема:', memeError);
                }
            }

            // Отправляем HTML файл, если сгенерирован код страницы/открытки
            if (responseObj.htmlCode && responseObj.htmlCode.trim()) {
                try {
                    const htmlContent = responseObj.htmlCode.trim();
                    const htmlBuffer = Buffer.from(htmlContent, 'utf8');
                    await ctx.replyWithDocument({
                        source: htmlBuffer, filename: 'card.html'
                    }, {
                        caption: 'Сэр, я спроектировал и собрал для вас эту HTML-страницу/открытку. Вы можете открыть этот файл в любом браузере.'
                    });
                } catch (htmlError) {
                    console.error('Ошибка отправки HTML файла:', htmlError);
                }
            }

            // Формируем описание входящего сообщения для логов в Markdown
            let userMsgSummary = promptText;
            if (ctx.message.photo) userMsgSummary += ' [Изображение]';
            if (ctx.message.voice) userMsgSummary += ' [Голосовое сообщение]';
            if (ctx.message.audio) userMsgSummary += ' [Аудиофайл]';
            if (ctx.message.document) userMsgSummary += ` [Документ: ${ctx.message.document.file_name}]`;
            if (!userMsgSummary.trim()) userMsgSummary = '[Медиа или неподдерживаемый тип]';

            // Пишем в человекочитаемый лог
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