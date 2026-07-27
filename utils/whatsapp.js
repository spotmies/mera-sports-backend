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
export const sendWhatsAppTemplate = async (mobile, templateName, components = []) => {
    if (!isWhatsAppEnabled()) {
        console.warn('WhatsApp disabled: WHATSAPP_PHONE_ID / WHATSAPP_TOKEN not set');
        return false;
    }

    const to = normalizeWhatsAppNumber(mobile);
    if (!to) {
        console.warn(`WhatsApp: invalid mobile number "${mobile}"`);
        return false;
    }

    try {
        await axios.post(
            `https://graph.facebook.com/${API_VERSION}/${PHONE_ID}/messages`,
            {
                messaging_product: 'whatsapp',
                to,
                type: 'template',
                template: {
                    name: templateName,
                    language: { code: 'en' },
                    components,
                },
            },
            { headers: { Authorization: `Bearer ${TOKEN}` }, timeout: 15000 }
        );
        return true;
    } catch (error) {
        const apiError = error.response?.data?.error;
        console.error(
            `WhatsApp send error (template=${templateName}):`,
            apiError ? `${apiError.code} ${apiError.message}` : error.message
        );
        return false;
    }
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
        ]);
        if (sent) return true;
        // Covers the window where `registration_receipt` is still under review
        // (Meta answers 132001 "template does not exist") as well as a rejected
        // template or an unreachable document link. The player still gets their
        // confirmation, just without the PDF attached.
        console.warn(`Receipt template "${TEMPLATES.receipt}" send failed — falling back to text confirmation`);
    }
    return sendRegistrationWhatsApp(mobile, details);
};
