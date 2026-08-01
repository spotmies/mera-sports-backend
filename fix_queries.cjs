const fs = require('fs');
let content = fs.readFileSync('c:/Spotmies/Sports paramount/mera-sports-backend/controllers/bracketController.js', 'utf8');

const regex = /if\s*\(\s*categoryId\s*&&\s*isUuid\(categoryId\)\s*\)\s*\{\s*(query|bracketQuery|checkQuery)\s*=\s*\1\.eq\("category_id"\s*,\s*categoryId\);\s*\}\s*else\s*\{\s*\1\s*=\s*\1\.eq\("category"\s*,\s*categoryLabel\);\s*\}/g;

const replacement = 'if (categoryId && isUuid(categoryId)) {\n            $1 = $1.eq("category_id", categoryId);\n        } else if (categoryId && !isUuid(categoryId)) {\n            $1 = $1.eq("category", categoryId);\n        } else {\n            $1 = $1.eq("category", categoryLabel);\n        }';

content = content.replace(regex, replacement);

fs.writeFileSync('c:/Spotmies/Sports paramount/mera-sports-backend/controllers/bracketController.js', content);
console.log('Replaced successfully');
