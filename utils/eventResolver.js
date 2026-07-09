import crypto from "crypto";
import { supabaseAdmin } from "../config/supabaseClient.js";

const normalizeEventId = (id) => {
    if (id === null || id === undefined || String(id).trim() === "") return null;
    const parsed = Number(id);
    return Number.isNaN(parsed) ? id : parsed;
};

const PUBLIC_ID_PREFIX = "evt";
const getSecret = () => process.env.EVENT_PUBLIC_ID_SECRET || process.env.JWT_SECRET || "event-public-id-fallback";

const hashToBigInt = (input) => {
    const hash = crypto.createHash("sha256").update(input).digest("hex");
    return BigInt(`0x${hash}`);
};

const getMaskBigInt = () => {
    const raw = hashToBigInt(getSecret());
    return raw === 0n ? 1n : raw;
};

const base36ToBigInt = (value) => {
    const chars = "0123456789abcdefghijklmnopqrstuvwxyz";
    const input = String(value || "").toLowerCase();
    let result = 0n;
    for (const char of input) {
        const digit = chars.indexOf(char);
        if (digit < 0) throw new Error("Invalid base36 character");
        result = result * 36n + BigInt(digit);
    }
    return result;
};

const signPart = (part) => crypto.createHmac("sha256", getSecret()).update(part).digest("hex").slice(0, 10);

export const buildDerivedPublicEventId = (internalId) => {
    if (internalId === null || internalId === undefined || String(internalId).trim() === "") return "";
    const numeric = BigInt(String(internalId));
    const obfuscated = (numeric ^ getMaskBigInt()).toString(36);
    const signature = signPart(obfuscated);
    return `${PUBLIC_ID_PREFIX}_${obfuscated}_${signature}`;
};

export const decodeDerivedPublicEventId = (identifier) => {
    const raw = String(identifier || "").trim();
    const parts = raw.split("_");
    if (parts.length !== 3 || parts[0] !== PUBLIC_ID_PREFIX) return null;

    const obfuscated = parts[1];
    const providedSignature = parts[2];
    const expectedSignature = signPart(obfuscated);
    if (providedSignature !== expectedSignature) return null;

    try {
        const decoded = base36ToBigInt(obfuscated) ^ getMaskBigInt();
        return decoded.toString();
    } catch {
        return null;
    }
};

export const getPublicEventId = (eventLike) => {
    if (!eventLike) return "";
    if (eventLike.public_id) return String(eventLike.public_id);
    return buildDerivedPublicEventId(eventLike.id);
};

export const resolveEventByIdentifier = async (identifier, selectColumns = "*") => {
    if (identifier === null || identifier === undefined || String(identifier).trim() === "") {
        return null;
    }

    const rawIdentifier = String(identifier).trim();

    const { data: byPublicId, error: publicError } = await supabaseAdmin
        .from("events")
        .select(selectColumns)
        .eq("public_id", rawIdentifier)
        .maybeSingle();

    if (publicError) throw publicError;
    if (byPublicId) return byPublicId;

    const derivedInternalId = decodeDerivedPublicEventId(rawIdentifier);
    if (derivedInternalId) {
        const normalizedDerivedId = normalizeEventId(derivedInternalId);
        const { data: byDerivedId, error: derivedError } = await supabaseAdmin
            .from("events")
            .select(selectColumns)
            .eq("id", normalizedDerivedId)
            .maybeSingle();

        if (derivedError) throw derivedError;
        if (byDerivedId) return byDerivedId;
    }

    const normalizedId = normalizeEventId(rawIdentifier);
    const { data: byInternalId, error: internalError } = await supabaseAdmin
        .from("events")
        .select(selectColumns)
        .eq("id", normalizedId)
        .maybeSingle();

    if (internalError) throw internalError;
    return byInternalId || null;
};

export const resolveEventIdByIdentifier = async (identifier) => {
    const event = await resolveEventByIdentifier(identifier, "id");
    return event?.id ?? null;
};
