const crypto = require("crypto");

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

module.exports = { encrypt, decrypt };
