import path from "path";
import { fileURLToPath } from "url";
import XLSX from "xlsx";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_FILE = path.join(__dirname, "data", "List of Pre -Listed Apartment ( 25.12.25).xlsx");

try {
    const workbook = XLSX.readFile(DATA_FILE);
    const sheetName = workbook.SheetNames[0];
    const sheet = workbook.Sheets[sheetName];
    const data = XLSX.utils.sheet_to_json(sheet, { header: 1 }); // Read as array of arrays to see headers

    console.log("Headers:", data[0]);
    console.log("First row data:", data[1]);
    console.log("Second row data:", data[2]);
} catch (error) {
    console.error("Error reading excel:", error);
}
