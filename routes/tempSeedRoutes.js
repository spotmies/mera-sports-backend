
import express from "express";
import { seedTestEvent } from "../controllers/seedController.js";

const router = express.Router();

router.get("/seed-data", seedTestEvent);

export default router;
