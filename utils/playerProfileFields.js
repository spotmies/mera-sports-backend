// Optional player profile fields added after launch. Every writer (register,
// profile edit, family member add/edit) goes through these so the stored value
// is trimmed and capped the same way regardless of entry point.

export const FLAT_BUILDING_WING_MAX = 150;
export const TSHIRT_SIZE_MAX = 20;

// Preset sizes offered by the dropdown. A custom size typed into the "Other"
// input is stored as-is, so this list is documentation + a hint, not a filter.
export const TSHIRT_SIZES = {
    Adult: ["XXL", "XL", "L", "Med", "S", "XS"],
    Kids: ["24", "26", "28", "30", "32", "33", "34"],
};

const clean = (value, max) => {
    if (typeof value !== "string") return null;
    const collapsed = value.replace(/\s+/g, " ").trim();
    return collapsed ? collapsed.slice(0, max) : null;
};

/** Flat / building / wing line of the address; null when blank. */
export const cleanFlatBuildingWing = (value) => clean(value, FLAT_BUILDING_WING_MAX);

/** T-shirt size; null when blank. e.g. "Adult - XL", "Kids - 28" or free text. */
export const cleanTshirtSize = (value) => clean(value, TSHIRT_SIZE_MAX);
