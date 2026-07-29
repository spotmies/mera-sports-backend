import dotenv from 'dotenv';
import axios from 'axios';

dotenv.config({ quiet: true });

// WhatsApp Cloud API (Meta Graph) — business-initiated messages must use pre-approved templates
const API_VERSION = process.env.WHATSAPP_API_VERSION || 'v25.0';
const PHONE_ID = process.env.WHATSAPP_PHONE_ID;
const TOKEN = process.env.WHATSAPP_TOKEN;

// Template names (override via env if renamed in WhatsApp Manager)
const TEMPLATES = {
    otp: process.env.WHATSAPP_TEMPLATE_OTP || 'otp',
    welcome: process.env.WHATSAPP_TEMPLATE_WELCOME || 'welcome_credentials',
    registration: process.env.WHATSAPP_TEMPLATE_REGISTRATION || 'registration_confirmation',
    status: process.env.WHATSAPP_TEMPLATE_STATUS || 'registration_status',
    // Same body as `registration`, but with a DOCUMENT header carrying the
    // receipt PDF. Separate template because changing an approved template's
    // header type requires resubmission to Meta.
    receipt: process.env.WHATSAPP_TEMPLATE_RECEIPT || 'registration_receipt',
    // Admin broadcasts. Two templates for the same message because a template's
    // header type is fixed at creation — the image variant cannot be derived
    // from the text one, exactly like `registration` vs `receipt` above.
    broadcast: process.env.WHATSAPP_TEMPLATE_BROADCAST || 'event_announcement',
    broadcastImage: process.env.WHATSAPP_TEMPLATE_BROADCAST_IMAGE || 'event_announcement_image',
};

export const isWhatsAppEnabled = () => Boolean(PHONE_ID && TOKEN);

/**
 * Normalize an Indian mobile number to WhatsApp international format (91XXXXXXXXXX)
 * @param {string|number} mobile
 * @returns {string|null}
 */
export const normalizeWhatsAppNumber = (mobile) => {
    if (!mobile) return null;
    const digits = String(mobile).replace(/\D/g, '');
    if (digits.length === 10) return `91${digits}`;
    if (digits.length === 11 && digits.startsWith('0')) return `91${digits.slice(1)}`;
    if (digits.length === 12 && digits.startsWith('91')) return digits;
    return null;
};

// WhatsApp rejects params containing newlines, tabs or 4+ consecutive spaces
const sanitizeParam = (value) =>
    String(value ?? '').replace(/\s+/g, ' ').trim() || '-';

const textParam = (value) => ({ type: 'text', text: sanitizeParam(value) });

/**
 * Send a template message via the WhatsApp Cloud API
 * @param {string} mobile - Recipient number (10-digit Indian or 91-prefixed)
 * @param {string} templateName
 * @param {Array} components - Template components (body/button parameters)
 * @returns {Promise<boolean>} true if the API accepted the message
 */
// Meta stores "English" and "English (US)" as separate translations (`en` and
// `en_US`) and error 132001 does not say which one it looked for. Whichever was
// picked in WhatsApp Manager is invisible from the API without the management
// scope, so a send that fails on the primary code is retried on the other.
const PRIMARY_LANG = process.env.WHATSAPP_TEMPLATE_LANG || 'en';
// `registration_receipt` was registered in WhatsApp Manager as English (US)
// while the others are plain English, so it needs its own default. Confirmed by
// a live send on 2026-07-27; the retry above still covers it if that changes.
const RECEIPT_LANG = process.env.WHATSAPP_TEMPLATE_RECEIPT_LANG || 'en_US';

const postTemplate = (to, templateName, components, langCode) =>
    axios.post(
        `https://graph.facebook.com/${API_VERSION}/${PHONE_ID}/messages`,
        {
            messaging_product: 'whatsapp',
            to,
            type: 'template',
            template: {
                name: templateName,
                language: { code: langCode },
                components,
            },
        },
        { headers: { Authorization: `Bearer ${TOKEN}` }, timeout: 15000 }
    );

/**
 * Same send as `sendWhatsAppTemplate`, but reports *what happened* instead of
 * just whether it worked: the broadcast pipeline stores Meta's message id per
 * recipient (the status webhook arrives keyed by that id and nothing else) and
 * shows the failure reason to the admin, so a bare boolean is not enough.
 *
 * @returns {Promise<{ok: boolean, messageId?: string, error?: string, code?: number}>}
 */
export const sendWhatsAppTemplateDetailed = async (mobile, templateName, components = [], langOverride = null) => {
    if (!isWhatsAppEnabled()) {
        console.warn('WhatsApp disabled: WHATSAPP_PHONE_ID / WHATSAPP_TOKEN not set');
        return { ok: false, error: 'WhatsApp is not configured on this server' };
    }

    const to = normalizeWhatsAppNumber(mobile);
    if (!to) {
        console.warn(`WhatsApp: invalid mobile number "${mobile}"`);
        return { ok: false, error: `Invalid mobile number "${mobile}"` };
    }

    const primaryLang = langOverride || PRIMARY_LANG;
    const altLang = primaryLang === 'en' ? 'en_US' : 'en';

    const messageIdOf = (response) => response?.data?.messages?.[0]?.id;

    try {
        const response = await postTemplate(to, templateName, components, primaryLang);
        return { ok: true, messageId: messageIdOf(response) };
    } catch (error) {
        const apiError = error.response?.data?.error;

        // 132001 = name/translation not found. Retry once on the other English
        // variant before giving up, so a template registered as en_US still sends.
        if (apiError?.code === 132001) {
            try {
                const response = await postTemplate(to, templateName, components, altLang);
                console.warn(`WhatsApp: template "${templateName}" sent as ${altLang} — set its language override to skip this retry`);
                return { ok: true, messageId: messageIdOf(response) };
            } catch (retryError) {
                const retryApiError = retryError.response?.data?.error;
                const detail = retryApiError
                    ? `${retryApiError.code} ${retryApiError.message}`
                    : retryError.message;
                console.error(
                    `WhatsApp send error (template=${templateName}, tried ${primaryLang} and ${altLang}):`,
                    detail
                );
                return { ok: false, error: detail, code: retryApiError?.code };
            }
        }

        const detail = apiError ? `${apiError.code} ${apiError.message}` : error.message;
        console.error(`WhatsApp send error (template=${templateName}):`, detail);
        return { ok: false, error: detail, code: apiError?.code };
    }
};

export const sendWhatsAppTemplate = async (mobile, templateName, components = [], langOverride = null) => {
    const { ok } = await sendWhatsAppTemplateDetailed(mobile, templateName, components, langOverride);
    return ok;
};

/**
 * Send an OTP via the approved "otp" authentication template
 * (body param = code, URL button param = code for one-tap copy)
 * @param {string} mobile
 * @param {string|number} otp
 */
export const sendOtpWhatsApp = (mobile, otp) =>
    sendWhatsAppTemplate(mobile, TEMPLATES.otp, [
        { type: 'body', parameters: [textParam(otp)] },
        { type: 'button', sub_type: 'url', index: '0', parameters: [textParam(otp)] },
    ]);

/**
 * Send the welcome + login credentials message (mirrors sendRegistrationSuccessEmail)
 * @param {string} mobile
 * @param {object} details - { name, playerId, password }
 */
export const sendWelcomeWhatsApp = (mobile, { name, playerId, password }) =>
    sendWhatsAppTemplate(mobile, TEMPLATES.welcome, [
        {
            type: 'body',
            parameters: [textParam(name), textParam(playerId), textParam(password)],
        },
    ]);

// Same category formatting as the registration email
const formatCategories = (category) => {
    if (!Array.isArray(category)) return category;
    return category
        .map((c) => {
            if (typeof c === 'object' && c !== null) {
                return `${c.name}${c.gender ? ` (${c.gender})` : ''}${c.matchType ? ` - ${c.matchType}` : ''}`;
            }
            return c;
        })
        .join(', ');
};

/**
 * Send the event registration confirmation / bill (mirrors sendRegistrationEmail)
 * @param {string} mobile
 * @param {object} details - { playerName, eventName, registrationNo, amount, category, status }
 */
/**
 * Send a registration status update (admin verified/rejected a registration)
 * @param {string} mobile
 * @param {object} details - { playerName, eventName, registrationNo, status }
 */
export const sendRegistrationStatusWhatsApp = (mobile, { playerName, eventName, registrationNo, status }) =>
    sendWhatsAppTemplate(mobile, TEMPLATES.status, [
        {
            type: 'body',
            parameters: [
                textParam(playerName),
                textParam(registrationNo),
                textParam(eventName),
                textParam(status),
            ],
        },
    ]);

const registrationBodyParams = ({ playerName, eventName, registrationNo, amount, category, status }) => [
    textParam(playerName),
    textParam(eventName),
    textParam(registrationNo),
    textParam(formatCategories(category)),
    textParam(amount),
    textParam(status || 'Verified'),
];

export const sendRegistrationWhatsApp = (mobile, details) =>
    sendWhatsAppTemplate(mobile, TEMPLATES.registration, [
        { type: 'body', parameters: registrationBodyParams(details) },
    ]);

/**
 * Send the registration confirmation with the receipt PDF attached as a
 * document. Meta fetches `documentUrl` server-side at send time, so it must be
 * publicly reachable without auth for the lifetime of the request (a signed
 * bucket URL is fine -- WhatsApp caches the media once delivered).
 *
 * @param {string} mobile
 * @param {object} details - same shape as sendRegistrationWhatsApp
 * @param {object} receipt - { documentUrl, filename }
 */
export const sendRegistrationReceiptWhatsApp = async (mobile, details, { documentUrl, filename } = {}) => {
    if (documentUrl) {
        const sent = await sendWhatsAppTemplate(mobile, TEMPLATES.receipt, [
            {
                type: 'header',
                parameters: [{
                    type: 'document',
                    document: { link: documentUrl, filename: filename || 'Receipt.pdf' },
                }],
            },
            { type: 'body', parameters: registrationBodyParams(details) },
        ], RECEIPT_LANG);
        if (sent) return true;
        // Covers the window where `registration_receipt` is still under review
        // (Meta answers 132001 "template does not exist") as well as a rejected
        // template or an unreachable document link. The player still gets their
        // confirmation, just without the PDF attached.
        console.warn(`Receipt template "${TEMPLATES.receipt}" send failed — falling back to text confirmation`);
    }
    return sendRegistrationWhatsApp(mobile, details);
};

/* ================= ADMIN BROADCASTS ================= */

// A template's body parameters are capped by Meta at 1024 characters. The admin
// UI enforces the same limit so the count shown while typing is the real one.
export const BROADCAST_MESSAGE_MAX = 1024;
export const BROADCAST_TITLE_MAX = 60;

/**
 * Render a broadcast exactly as WhatsApp will deliver it.
 *
 * Template parameters cannot contain newlines, tabs or runs of 4+ spaces —
 * Meta rejects the send outright (error 132000). `sanitizeParam` collapses them,
 * which means a message typed as several paragraphs arrives as one. That is a
 * property of templates, not a bug, so the admin UI previews the *sanitized*
 * text and this helper is what it previews with.
 *
 * @param {object} broadcast - { title, message }
 * @param {string} recipientName
 */
export const renderBroadcastPreview = ({ title, message }, recipientName = 'Player') => ({
    header: sanitizeParam(title).slice(0, BROADCAST_TITLE_MAX),
    body: `Hi ${sanitizeParam(recipientName)},\n\n${sanitizeParam(message).slice(0, BROADCAST_MESSAGE_MAX)}\n\nOpen the Sports Paramount app for full details.`,
    footer: 'Sports Paramount',
});

/**
 * Send one admin broadcast message.
 *
 * Picks the image-header template when an image is attached and the text-header
 * one otherwise — a single template cannot do both, since the header type is
 * fixed when Meta approves it.
 *
 * `imageUrl` must be directly fetchable by Meta's media downloader: pass a
 * signed bucket URL, NOT the `/api/files/...` route, which answers with a 302
 * that Meta does not reliably follow (same trap as the receipt PDF).
 *
 * @param {string} mobile
 * @param {object} broadcast - { title, message, imageUrl? }
 * @param {string} recipientName
 * @returns {Promise<{ok: boolean, messageId?: string, error?: string, code?: number}>}
 */
export const sendBroadcastWhatsApp = (mobile, { title, message, imageUrl } = {}, recipientName = 'Player') => {
    const bodyParams = [
        textParam(recipientName),
        textParam(String(message ?? '').slice(0, BROADCAST_MESSAGE_MAX)),
    ];

    if (imageUrl) {
        return sendWhatsAppTemplateDetailed(mobile, TEMPLATES.broadcastImage, [
            { type: 'header', parameters: [{ type: 'image', image: { link: imageUrl } }] },
            { type: 'body', parameters: bodyParams },
        ]);
    }

    return sendWhatsAppTemplateDetailed(mobile, TEMPLATES.broadcast, [
        { type: 'header', parameters: [textParam(String(title ?? '').slice(0, BROADCAST_TITLE_MAX))] },
        { type: 'body', parameters: bodyParams },
    ]);
};

export const BROADCAST_TEMPLATES = {
    text: TEMPLATES.broadcast,
    image: TEMPLATES.broadcastImage,
};
