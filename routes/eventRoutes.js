import { cacheRoute } from "../middleware/responseCache.js";
import express from "express";
import {
    createEvent,
    deleteEvent,
    getEventBrackets,
    getEventDetails,
    getEventSponsors,
    listEvents,
    setCategoryRegistrationStatus,
    updateEvent
} from "../controllers/eventController.js";
import { getPublicMatches } from "../controllers/matchController.js";
import { fromParam, requireEventAccess } from "../middleware/eventAccess.js";
import { verifyAdmin } from "../middleware/rbacMiddleware.js";

// Admins may only change events they created or are assigned to.
const eventAccess = requireEventAccess(fromParam("id"));

const router = express.Router();

router.post('/create', verifyAdmin, createEvent);
router.get('/list', cacheRoute('events-list', 20), listEvents);
router.get('/:id', getEventDetails);
router.get('/:id/brackets', cacheRoute('brackets', 60), getEventBrackets);
router.get('/:id/matches', getPublicMatches); // Public scoreboard endpoint
router.get('/:id/sponsors', cacheRoute('sponsors', 60), getEventSponsors);
router.patch('/:id/categories/:categoryId/registration', verifyAdmin, eventAccess, setCategoryRegistrationStatus);
router.put('/:id', verifyAdmin, eventAccess, updateEvent);
router.delete('/:id', verifyAdmin, eventAccess, deleteEvent);

export default router;
