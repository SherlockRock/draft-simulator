const crypto = require("crypto");
const DraftShare = require("./models/DraftShare");

const encrypt = (token) => {
  const key = Buffer.from(process.env.ENCRYPTION_KEY, "base64"); // Must be 32 bytes for aes-256
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv("aes-256-cbc", key, iv);
  let encrypted = cipher.update(token, "utf8", "hex");
  encrypted += cipher.final("hex");

  // Prepend IV to the encrypted data, both in hex
  const ivHex = iv.toString("hex");
  return ivHex + ":" + encrypted;
};

const decrypt = (data) => {
  const key = Buffer.from(process.env.ENCRYPTION_KEY, "base64");

  const [ivHex, encrypted] = data.split(":");
  const iv = Buffer.from(ivHex, "hex");

  const decipher = crypto.createDecipheriv("aes-256-cbc", key, iv);
  let decrypted = decipher.update(encrypted, "hex", "utf8");
  decrypted += decipher.final("utf8");
  return decrypted;
};

const draftHasSharedWithUser = async (draft, user) => {
  try {
    const share = await DraftShare.findOne({
      where: { draft_id: draft.id, user_id: user.id },
    });
    return share !== null;
  } catch (error) {
    console.error("Error checking draft share:", error);
    return res.status(403).json({ error: "Unauthorized" });
  }
};

/**
 * Generates a unique name for a draft within a specific canvas.
 * If the name exists, appends " 1", " 2", etc. until a unique name is found.
 * Only checks canvas drafts (type = 'canvas') for uniqueness.
 * Standalone drafts on the canvas are ignored.
 *
 * @param {string} baseName - The desired draft name
 * @param {string} canvasId - The canvas ID to check uniqueness within
 * @param {string|null} excludeDraftId - Draft ID to exclude from check (for renames)
 * @returns {Promise<string>} - A unique name for the canvas
 */
async function generateUniqueCanvasDraftName(
  baseName,
  canvasId,
  excludeDraftId = null
) {
  const { CanvasDraft } = require("./models/Canvas");
  const Draft = require("./models/Draft");

  const MAX_NAME_LENGTH = 250; // Leave room for number suffix
  let trimmedBaseName = baseName;

  // Trim base name if too long
  if (baseName.length > MAX_NAME_LENGTH) {
    trimmedBaseName = baseName.substring(0, MAX_NAME_LENGTH);
  }

  const canvasDrafts = await CanvasDraft.findAll({
    where: { canvas_id: canvasId },
    include: [
      {
        model: Draft,
        attributes: ["id", "name", "type"],
      },
    ],
  });

  // Build set of existing names (excluding the draft being renamed)
  // Only check canvas-type drafts for uniqueness
  const existingNames = new Set(
    canvasDrafts
      .filter((cd) => cd.Draft.id !== excludeDraftId && cd.Draft.type === 'canvas')
      .map((cd) => cd.Draft.name)
  );

  // If base name is unique, return it
  if (!existingNames.has(trimmedBaseName)) {
    return trimmedBaseName;
  }

  // Name collision detected - parse existing number from name if present
  const numberMatch = trimmedBaseName.match(/^(.+?)\s+(\d+)$/);
  let baseNameWithoutNumber;
  let startingCounter;

  if (numberMatch) {
    baseNameWithoutNumber = numberMatch[1];
    startingCounter = parseInt(numberMatch[2], 10) + 1;
  } else {
    baseNameWithoutNumber = trimmedBaseName;
    startingCounter = 1;
  }

  // Find the next available number
  let counter = startingCounter;
  let candidateName = `${baseNameWithoutNumber} ${counter}`;

  while (existingNames.has(candidateName)) {
    counter++;
    candidateName = `${baseNameWithoutNumber} ${counter}`;
  }

  return candidateName;
}

module.exports = {
  encrypt,
  decrypt,
  draftHasSharedWithUser,
  generateUniqueCanvasDraftName,
};
