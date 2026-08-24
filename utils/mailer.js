import dotenv from 'dotenv';
import { Resend } from 'resend';
import { generateReceiptPdf, receiptFilename } from './receiptPdf.js';

dotenv.config({ quiet: true });

const resend = new Resend(process.env.RESEND_API_KEY);

// Sender address — must use a domain verified in your Resend account.
// During onboarding Resend provides onboarding@resend.dev for testing.
const FROM_ADDRESS = process.env.RESEND_FROM || 'SPORTS PARAMOUNT <onboarding@resend.dev>';

/**
 * Send Event Registration Success Email (with PDF receipt attachment)
 * @param {string} toEmail - Recipient Email
 * @param {object} details - { playerName, eventName, registrationNo, amount, category, date, status }
 */
export const sendRegistrationEmail = async (toEmail, details) => {
    if (!toEmail) return false;

    const { playerName, eventName, registrationNo, amount, category, date } = details;

    const categoriesText = Array.isArray(category)
        ? category.map(c => {
            if (typeof c === 'object') {
                return `${c.name}${c.gender ? ` (${c.gender})` : ''}${c.matchType ? ` - ${c.matchType}` : ''}`;
            }
            return c;
        }).join(', ')
        : category;

    const html = `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; border: 1px solid #e0e0e0; border-radius: 8px; overflow: hidden;">
            <div style="background-color: #4F46E5; padding: 20px; text-align: center; color: white;">
                <h1 style="margin: 0;">Registration Confirmed!</h1>
            </div>
            <div style="padding: 30px;">
                <p>Dear <strong>${playerName}</strong>,</p>
                <p>Your registration for <strong>${eventName}</strong> has been successfully received.</p>

                <div style="background-color: #f9fafb; padding: 15px; border-radius: 6px; margin: 20px 0;">
                    <p style="margin: 5px 0;"><strong>Registration No:</strong> ${registrationNo}</p>
                    <p style="margin: 5px 0;"><strong>Event:</strong> ${eventName}</p>
                    <p style="margin: 5px 0;"><strong>Categories:</strong> ${categoriesText}</p>
                    <p style="margin: 5px 0;"><strong>Amount Paid:</strong> ₹${amount}</p>
                    <p style="margin: 5px 0;"><strong>Date:</strong> ${new Date(date).toLocaleDateString()}</p>
                    <p style="margin: 5px 0;"><strong>Status:</strong> <span style="text-transform: uppercase;">${details.status || 'Verified'}</span></p>
                </div>

                <p>Your receipt is attached to this email as a PDF. Please carry a digital or physical copy to the venue for verification.</p>
                <p>Good luck!</p>
            </div>
            <div style="background-color: #f3f4f6; padding: 15px; text-align: center; color: #6b7280; font-size: 12px;">
                &copy; ${new Date().getFullYear()} Sports Paramount. All rights reserved.
            </div>
        </div>
    `;

    // Build attachments — degrade gracefully if PDF generation fails
    let attachments = [];
    try {
        const pdfBuffer = await generateReceiptPdf(details);
        attachments = [{
            filename: receiptFilename(registrationNo),
            content: pdfBuffer.toString('base64'),
        }];
    } catch (pdfErr) {
        console.error('Receipt PDF generation failed, sending email without attachment:', pdfErr.message);
    }

    try {
        const { error } = await resend.emails.send({
            from: FROM_ADDRESS,
            to: [toEmail],
            subject: `Registration Confirmed: ${eventName}`,
            html,
            attachments,
        });

        if (error) {
            console.error('Resend error (sendRegistrationEmail):', error);
            return false;
        }
        return true;
    } catch (err) {
        console.error('Error sending registration email:', err);
        return false;
    }
};

/**
 * Send Player Registration Success Email (Welcome Email with credentials)
 * @param {string} toEmail - Recipient Email
 * @param {object} details - { name, playerId, password }
 */
export const sendRegistrationSuccessEmail = async (toEmail, details) => {
    if (!toEmail) return false;

    const { name, playerId, password } = details;
    const loginLink = 'https://www.sportsparamount.com/login';

    const html = `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; border: 1px solid #e0e0e0; border-radius: 8px; overflow: hidden;">
            <div style="background-color: #4F46E5; padding: 20px; text-align: center; color: white;">
                <h1 style="margin: 0;">Welcome to Sports Paramount!</h1>
            </div>
            <div style="padding: 30px;">
                <p>Dear <strong>${name}</strong>,</p>
                <p>You have successfully registered on Sports Paramount. We are excited to have you on board!</p>

                <div style="background-color: #f0fdf4; border: 1px solid #bbf7d0; padding: 15px; border-radius: 6px; margin: 20px 0;">
                    <p style="margin: 0 0 10px 0; color: #166534; font-weight: bold;">Your Login Credentials:</p>
                    <p style="margin: 5px 0;"><strong>Player ID:</strong> <span style="font-family: monospace; background: #fff; padding: 2px 5px; border-radius: 4px;">${playerId}</span></p>
                    <p style="margin: 5px 0;"><strong>Password:</strong> <span style="font-family: monospace; background: #fff; padding: 2px 5px; border-radius: 4px;">${password}</span></p>
                    <p style="margin: 5px 0; font-size: 12px; color: #666;">(Note: Your password is your Date of Birth in DDMMYYYY format)</p>
                </div>

                <div style="text-align: center; margin: 25px 0;">
                    <a href="${loginLink}" style="background-color: #4F46E5; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; font-weight: bold;">Login to Dashboard</a>
                </div>

                <p>Please keep these credentials safe. You can change your password after logging in.</p>
            </div>
            <div style="background-color: #f3f4f6; padding: 15px; text-align: center; color: #6b7280; font-size: 12px;">
                &copy; ${new Date().getFullYear()} Sports Paramount. All rights reserved.
            </div>
        </div>
    `;

    try {
        const { error } = await resend.emails.send({
            from: FROM_ADDRESS,
            to: [toEmail],
            subject: 'Welcome to Sports Paramount! Registration Successful',
            html,
        });

        if (error) {
            console.error('Resend error (sendRegistrationSuccessEmail):', error);
            return false;
        }
        return true;
    } catch (err) {
        console.error('Error sending welcome email:', err);
        return false;
    }
};

/**
 * Send an OTP / Verification Code Email
 * @param {string} toEmail
 * @param {string} otp
 */
export const sendOtpEmail = async (toEmail, otp) => {
    if (!toEmail) return false;

    const html = `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; border: 1px solid #e0e0e0; border-radius: 8px; overflow: hidden;">
            <div style="background-color: #4F46E5; padding: 20px; text-align: center; color: white;">
                <h1 style="margin: 0;">Verification Code</h1>
            </div>
            <div style="padding: 30px; text-align: center;">
                <p>Your one-time password (OTP) is:</p>
                <div style="font-size: 32px; font-weight: bold; letter-spacing: 5px; color: #4F46E5; margin: 20px 0;">
                    ${otp}
                </div>
                <p style="color: #666; font-size: 14px;">This code will expire in 10 minutes.</p>
                <p style="color: #999; font-size: 12px;">If you did not request this code, please ignore this email.</p>
            </div>
            <div style="background-color: #f3f4f6; padding: 15px; text-align: center; color: #6b7280; font-size: 12px;">
                &copy; ${new Date().getFullYear()} Sports Paramount. All rights reserved.
            </div>
        </div>
    `;

    try {
        const { error } = await resend.emails.send({
            from: FROM_ADDRESS,
            to: [toEmail],
            subject: 'Your Verification Code - Sports Paramount',
            html,
        });

        if (error) {
            console.error('Resend error (sendOtpEmail):', error);
            return false;
        }
        return true;
    } catch (err) {
        console.error('Error sending OTP email:', err);
        return false;
    }
};
