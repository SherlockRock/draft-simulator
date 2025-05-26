const crypto = require("crypto");

const encrypt = (token) => {
  const key = Buffer.from(process.env.ENCRYPTION_KEY, "base64");
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv("aes-256-cbc", key, iv);
  let encrypted = cipher.update(token, "utf8", "hex");
  encrypted += cipher.final("hex");
  return encrypted;
};

const decrypt = (encryptedToken) => {
  const key = Buffer.from(process.env.ENCRYPTION_KEY, "base64");
  const iv = crypto.randomBytes(16);
  const decipher = crypto.createDecipheriv("aes-256-cbc", key, iv);
  let decrypted = decipher.update(encryptedToken, "hex", "utf8");
  decrypted += decipher.final("utf8");
  return decrypted;
};

module.exports = { encrypt, decrypt };
