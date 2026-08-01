const fs = require('fs');
let content = fs.readFileSync('c:/Spotmies/Sports paramount/mera-sports-backend/controllers/bracketController.js', 'utf8');

let lines = content.split('\n');

const initBracketLineIndex = lines.findIndex((l, idx) => idx > 0 && l.includes('            category_id: categoryId && isUuid(categoryId) ? categoryId : null,') && lines[idx - 1].includes('            category: categoryLabel,'));
if (initBracketLineIndex !== -1) {
    lines[initBracketLineIndex - 1] = '            category: (categoryId && !isUuid(categoryId)) ? categoryId : categoryLabel,';
}

const uploadMediaLineIndex = lines.findIndex((l, idx) => idx > initBracketLineIndex && l.includes('                category_id: categoryId && isUuid(categoryId) ? categoryId : null,') && lines[idx - 1].includes('                category: categoryLabel,'));
if (uploadMediaLineIndex !== -1) {
    lines[uploadMediaLineIndex - 1] = '                category: (categoryId && !isUuid(categoryId)) ? categoryId : categoryLabel,';
}

const summaryStartIndex = lines.findIndex(l => l.includes('            const labelRow = rows.find(r => r.category && !isUuid(r.category)) || rows[0];'));
const summaryEndIndex = lines.findIndex((l, idx) => idx > summaryStartIndex && l.includes('                mode: bracketDraw ? "BRACKET" : (hasActualMedia ? "MEDIA" : null),'));

if (summaryStartIndex !== -1 && summaryEndIndex !== -1) {
    const replacement = [
        '            // Prefer a human-readable label over a row that stored the raw UUID.',
        '            const labelRow = rows.find(r => r.category && !isUuid(r.category)) || rows[0];',
        '            const catStr = labelRow?.category || "";',
        '            // Detect synthetic IDs (e.g., "1785400000042" or "1785400000042_R2")',
        '            const isSyntheticId = catStr && /^\\d+/.test(catStr) && !catStr.includes(" ");',
        '',
        '            draws.push({',
        '                categoryId: rows.find(r => r.category_id)?.category_id || (isSyntheticId ? catStr : null),',
        '                categoryLabel: isSyntheticId ? null : catStr,',
        '                mode: bracketDraw ? "BRACKET" : (hasActualMedia ? "MEDIA" : null),'
    ];
    lines.splice(summaryStartIndex, summaryEndIndex - summaryStartIndex + 1, ...replacement);
}

fs.writeFileSync('c:/Spotmies/Sports paramount/mera-sports-backend/controllers/bracketController.js', lines.join('\n'));
console.log('Fixed successfully');
