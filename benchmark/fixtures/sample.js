/**
 * UserService - handles all user-related operations.
 * This is the main service class for user management.
 * It provides CRUD operations and authentication helpers.
 *
 * @module UserService
 * @version 2.1.0
 */

// Import dependencies
import bcrypt from "bcrypt"; // for password hashing
import jwt from "jsonwebtoken"; // for token generation
import db from "./db.js"; // database connection pool

// Constants
const SALT_ROUNDS = 12; // bcrypt cost factor - higher = slower but safer
const TOKEN_EXPIRY = "7d"; // JWT expiry duration

/**
 * Creates a new user in the database.
 * Validates email uniqueness and hashes password before storing.
 *
 * @param {string} email - User's email address (must be unique)
 * @param {string} password - Plain-text password (will be hashed)
 * @param {string} role - User role: 'admin' | 'user' | 'guest'
 * @returns {Promise<Object>} Created user object (without password)
 * @throws {Error} If email already exists
 */
async function createUser(email, password, role = "user") {
  // Check for existing user first
  const existing = await db.query("SELECT id FROM users WHERE email = $1", [email]);
  if (existing.rows.length > 0) {
    throw new Error("Email already registered"); // duplicate check
  }

  // Hash the password - never store plain text
  const hash = await bcrypt.hash(password, SALT_ROUNDS);

  // Insert and return the new record
  const result = await db.query(
    "INSERT INTO users (email, password_hash, role) VALUES ($1, $2, $3) RETURNING id, email, role, created_at",
    [email, hash, role]
  );

  return result.rows[0]; // return without password_hash
}

/**
 * Authenticates a user and returns a signed JWT.
 *
 * @param {string} email
 * @param {string} password
 * @returns {Promise<string>} Signed JWT token
 * @throws {Error} If credentials are invalid
 */
async function loginUser(email, password) {
  // Fetch user record
  const result = await db.query("SELECT * FROM users WHERE email = $1", [email]);
  const user = result.rows[0];

  // Validate existence and password
  if (!user || !(await bcrypt.compare(password, user.password_hash))) {
    throw new Error("Invalid credentials"); // deliberately vague for security
  }

  // Sign and return token
  const token = jwt.sign(
    { id: user.id, role: user.role }, // payload
    process.env.JWT_SECRET,           // secret from env
    { expiresIn: TOKEN_EXPIRY }        // options
  );

  return token;
}

/**
 * Fetches a user by ID, stripping sensitive fields.
 *
 * @param {number} id
 * @returns {Promise<Object|null>}
 */
async function getUserById(id) {
  const result = await db.query(
    "SELECT id, email, role, created_at FROM users WHERE id = $1",
    [id]
  );
  return result.rows[0] || null; // null if not found
}

/**
 * Updates a user's role. Admin-only operation.
 *
 * @param {number} id
 * @param {string} newRole
 * @returns {Promise<Object>} Updated user
 */
async function updateUserRole(id, newRole) {
  // Validate role value before writing
  const validRoles = ["admin", "user", "guest"];
  if (!validRoles.includes(newRole)) {
    throw new Error(`Invalid role: ${newRole}`); // fail fast on bad input
  }

  const result = await db.query(
    "UPDATE users SET role = $1 WHERE id = $2 RETURNING id, email, role",
    [newRole, id]
  );

  if (result.rows.length === 0) throw new Error("User not found");
  return result.rows[0];
}

/**
 * Soft-deletes a user by setting deleted_at timestamp.
 * Hard deletes are not supported to preserve audit trail.
 *
 * @param {number} id
 * @returns {Promise<void>}
 */
async function deleteUser(id) {
  // Use soft delete - never hard delete users
  await db.query("UPDATE users SET deleted_at = NOW() WHERE id = $1", [id]);
}

// Export all public functions
export { createUser, loginUser, getUserById, updateUserRole, deleteUser };
