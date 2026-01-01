import dotenv from 'dotenv';
import nodemailer from 'nodemailer';

dotenv.config();

// Create Reusable Transporter
const transporter = nodemailer.createTransport({
    service: 'gmail', // or use 'host' & 'port' for other providers
    auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS
    }
});

/**
 * Send Event Registration Success Email
 * @param {string} toEmail - Recipient Email
 * @param {object} details - Registration Details { playerName, eventName, registrationNo, amount, category, date }
 */
export const sendRegistrationEmail = async (toEmail, details) => {
    if (!toEmail) return;

    const { playerName, eventName, registrationNo, amount, category, date } = details;

    const mailOptions = {
        from: `"SPORTS PARAMOUNT" <${process.env.EMAIL_USER}>`,
        to: toEmail,
        subject: `Registration Confirmed: ${eventName}`,
        html: `
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
                        <p style="margin: 5px 0;"><strong>Categories:</strong> ${Array.isArray(category) ? category.map(c => c.name || c).join(', ') : category}</p>
                        <p style="margin: 5px 0;"><strong>Amount Paid:</strong> ₹${amount}</p>
                        <p style="margin: 5px 0;"><strong>Date:</strong> ${new Date(date).toLocaleDateString()}</p>
                    </div>

                    <p>Please carry a digital or physical copy of this email to the venue for verification.</p>
                    <p>Good luck!</p>
                </div>
                <div style="background-color: #f3f4f6; padding: 15px; text-align: center; color: #6b7280; font-size: 12px;">
                    &copy; ${new Date().getFullYear()} Sports Paramount. All rights reserved.
                </div>
            </div>
        `
    };

    try {
        const info = await transporter.sendMail(mailOptions);
        console.log("Email sent: " + info.response);
        return true;
    } catch (error) {
        console.error("Error sending email:", error);
        return false;
    }
};

/**
 * Send Player Registration Success Email (Welcome Email)
 * @param {string} toEmail - Recipient Email
 * @param {object} details - { name, playerId, password }
 */
export const sendRegistrationSuccessEmail = async (toEmail, details) => {
    if (!toEmail) return;

    const { name, playerId, password } = details;
    const loginLink = "https://sportsparamount.com/login";

    const mailOptions = {
        from: `"SPORTS PARAMOUNT" <${process.env.EMAIL_USER}>`,
        to: toEmail,
        subject: `Welcome to Sports Paramount! Registration Successful`,
        html: `
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
        `
    };

    try {
        const info = await transporter.sendMail(mailOptions);
        console.log("Welcome Email sent: " + info.response);
        return true;
    } catch (error) {
        console.error("Error sending welcome email:", error);
        return false;
    }
};
