require('dotenv').config();
const fs = require('fs');
const express = require('express');
const path = require('path');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 3000;
const OPEN_LIBRARY = 'https://openlibrary.org';
const googleKey = process.env.GOOGLE_BOOKS_API_KEY;
const db = process.env.DATABASE_URL ? new Pool({ connectionString: process.env.DATABASE_URL }) : null;
const jwtSecret = process.env.JWT_SECRET || 'development-only-secret-change-me';
const BISAC_PATH = path.join(__dirname, 'data', 'bisac.csv');
const BISAC_BY_CODE = new Map(fs.readFileSync(BISAC_PATH, 'utf8').trim().split(/\r?\n/).map((line) => {
  const comma = line.indexOf(',');
  return [line.slice(0, comma).replace(/^"|"$/g, ''), line.slice(comma + 1).replace(/^"|"$/g, '')];
}));
function normaliseBisacText(value) { return String(value || '').toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]+/g, ' ').trim(); }
const BISAC_ENTRIES = [...BISAC_BY_CODE].map(([code, category]) => {
  const details = category.split('/').map((part) => part.trim()).slice(1).filter((part) => part.toLowerCase() !== 'general');
  const aliases = [details.join(' ')];
  if (details.length === 1 && category.startsWith('Fiction /')) aliases.push(details[0]);
  return { code, category, aliases: [...new Set(aliases.map(normaliseBisacText).filter((alias) => alias.length >= 4))] };
});
const BISAC_SYNONYM_RULES = [
  { code: 'FIC009000', terms: ['fantasy', 'magic', 'dragons', 'witchcraft', 'wizards'] },
  { code: 'FIC028000', terms: ['science fiction', 'dystopian', 'space travel', 'time travel', 'cyberpunk'] },
  { code: 'FIC027000', terms: ['romance', 'love stories', 'romantic fiction'] },
  { code: 'FIC022000', terms: ['mystery', 'detective', 'crime fiction', 'whodunit'] },
  { code: 'FIC030000', terms: ['thriller', 'suspense'] },
  { code: 'FIC015000', terms: ['horror', 'ghost stories', 'supernatural horror'] },
  { code: 'FIC002000', terms: ['adventure', 'quests', 'survival stories'] },
  { code: 'FIC043000', terms: ['coming of age'] },
  { code: 'JUV035000', terms: ['school stories', 'school fiction'] },
  { code: 'FIC014000', terms: ['historical fiction', 'historical novels'] },
  { code: 'FIC019000', terms: ['literary fiction', 'literary novels'] },
];

app.use(express.json({ limit: '100kb' }));

const cover = (id) => id ? `https://covers.openlibrary.org/b/id/${id}-M.jpg` : '';
const unique = (values = []) => [...new Set(values.filter(Boolean).map((value) => String(value).trim()))];
function normaliseGenres(values = []) {
  const labels = unique(values).map(normaliseBisacText);
  const directMatches = BISAC_ENTRIES.filter(({ aliases }) => aliases.some((alias) => labels.some((label) => {
    const aliasWords = alias.split(' ');
    const labelWords = new Set(label.split(' '));
    return label === alias || (aliasWords.length > 1 && aliasWords.every((word) => labelWords.has(word)));
  }))).map(({ code }) => code);
  const synonymMatches = BISAC_SYNONYM_RULES.filter(({ terms }) => terms.some((term) => labels.some((label) => label.includes(normaliseBisacText(term))))).map(({ code }) => code);
  return unique([...directMatches, ...synonymMatches]);
}
function genreLabels(codes = []) { return codes.map((code) => BISAC_BY_CODE.get(code)).filter(Boolean).map((label) => label.replace(/^Fiction \/ /, '').replace(/ \/ General$/, '')); }
function genreSearchTerm(code) { const rule = BISAC_SYNONYM_RULES.find((item) => item.code === code); return rule?.terms[0] || BISAC_ENTRIES.find((item) => item.code === code)?.aliases[0] || ''; }
function openLibraryBook(book) { const rawSubjects = unique(book.subject).slice(0, 12); const normalizedGenres = normaliseGenres(rawSubjects); return { id: `ol:${book.key}`, title: book.title || 'Untitled', author: book.author_name?.[0] || 'Unknown author', year: book.first_publish_year || null, cover: cover(book.cover_i), rawSubjects, normalizedGenres, subjects: genreLabels(normalizedGenres), ratingCount: 0, averageRating: null, source: 'Open Library' }; }
function googleBook(item) { const info = item.volumeInfo || {}; const rawSubjects = unique(info.categories).slice(0, 12); const normalizedGenres = normaliseGenres(rawSubjects); return { id: `gb:${item.id}`, title: info.title || 'Untitled', author: info.authors?.[0] || 'Unknown author', year: Number.parseInt(info.publishedDate, 10) || null, cover: info.imageLinks?.thumbnail?.replace('http:', 'https:') || '', rawSubjects, normalizedGenres, subjects: genreLabels(normalizedGenres), ratingCount: info.ratingsCount || 0, averageRating: info.averageRating || null, source: 'Google Books', description: info.description || '' }; }
async function openSearch(query, limit = 20) { const url = new URL(`${OPEN_LIBRARY}/search.json`); url.search = new URLSearchParams({ q: query, limit, fields: 'key,title,author_name,first_publish_year,cover_i,subject,edition_count' }); const response = await fetch(url); if (!response.ok) throw new Error('Open Library is unavailable.'); const data = await response.json(); return data.docs.map(openLibraryBook); }
async function googleSearch(query, limit = 10, subjectOnly = false) { const url = new URL('https://www.googleapis.com/books/v1/volumes'); url.searchParams.set('q', subjectOnly ? `subject:${query}` : query); url.searchParams.set('maxResults', String(limit)); url.searchParams.set('printType', 'books'); if (googleKey) url.searchParams.set('key', googleKey); const response = await fetch(url); if (!response.ok) return []; const data = await response.json(); return (data.items || []).map(googleBook); }
function readerPopularity(book) { return book.ratingCount ? Math.log10(book.ratingCount + 1) * ((book.averageRating || 0) / 5) : 0; }
async function catalogueSearch(query, limit = 20, subjectOnly = false) {
  const [open, google] = await Promise.all([openSearch(query, limit), googleSearch(query, Math.min(limit, 10), subjectOnly)]);
  const interleaved = [];
  for (let index = 0; index < Math.max(open.length, google.length); index += 1) {
    if (open[index]) interleaved.push(open[index]);
    if (google[index]) interleaved.push(google[index]);
  }
  const merged = new Map();
  for (const book of interleaved) {
    const key = `${book.title.toLowerCase()}|${book.author.toLowerCase()}`;
    const existing = merged.get(key);
    if (existing) {
      existing.sources = unique([...existing.sources, book.source]);
      existing.normalizedGenres = unique([...existing.normalizedGenres, ...book.normalizedGenres]);
      existing.subjects = genreLabels(existing.normalizedGenres);
      if (book.ratingCount > existing.ratingCount) {
        existing.ratingCount = book.ratingCount;
        existing.averageRating = book.averageRating;
      }
      if (!existing.cover && book.cover) existing.cover = book.cover;
      if (!existing.description && book.description) existing.description = book.description;
    } else {
      merged.set(key, { ...book, sources: [book.source] });
    }
  }
  return [...merged.values()].sort((a, b) => readerPopularity(b) - readerPopularity(a)).slice(0, limit);
}
function normaliseText(value) { return String(value || '').toLowerCase().replace(/[^a-z0-9]/g, ''); }
function score(candidate, chosen) { const selectedGenres = chosen.normalizedGenres || []; const genreOverlap = candidate.normalizedGenres.filter((genre) => selectedGenres.includes(genre)).length; const authorMatch = normaliseText(candidate.author) === normaliseText(chosen.author) ? 2 : 0; const yearSimilarity = candidate.year && chosen.year && Math.abs(candidate.year - chosen.year) <= 15 ? 1 : 0; return genreOverlap * 8 + authorMatch + yearSimilarity; }
function isEditorialTitle(book) { return /\b(bibliography|reference|encyclopedia|handbook|textbook|study guide|literary criticism)\b/i.test(book.title); }
function isSameSeries(candidate, chosen) { const words = chosen.title.toLowerCase().replace(/[^a-z0-9 ]/g, '').split(/\s+/).filter((word) => word.length > 3).slice(0, 2); return words.length === 2 && words.every((word) => candidate.title.toLowerCase().includes(word)); }
function requireDatabase(req, res, next) { if (!db) return res.status(503).json({ error: 'Database is not configured yet. Add DATABASE_URL and run npm run db:migrate.' }); next(); }
function requireUser(req, res, next) { const token = req.headers.authorization?.replace('Bearer ', ''); if (!token) return res.status(401).json({ error: 'Please sign in first.' }); try { req.user = jwt.verify(token, jwtSecret); next(); } catch { res.status(401).json({ error: 'Your session has expired. Please sign in again.' }); } }
function userToken(user) { return jwt.sign({ id: user.id, email: user.email }, jwtSecret, { expiresIn: '7d' }); }

app.get('/api/books/search', async (req, res) => { const query = String(req.query.q || '').trim(); if (!query) return res.status(400).json({ error: 'A search query is required.' }); try { const books = await catalogueSearch(query); const sources = { openLibrary: books.filter((book) => book.sources.includes('Open Library')).length, googleBooks: books.filter((book) => book.sources.includes('Google Books')).length }; res.json({ books, sources }); } catch (error) { res.status(502).json({ error: error.message }); } });
app.get('/api/genres', (req, res) => { const query = normaliseBisacText(req.query.q); const genres = BISAC_ENTRIES.filter(({ code, category }) => !query || normaliseBisacText(`${code} ${category}`).includes(query)); res.json({ total: BISAC_ENTRIES.length, genres }); });
app.post('/api/books/recommendations', async (req, res) => { const chosen = req.body.book; if (!chosen?.title) return res.status(400).json({ error: 'A book is required.' }); try { const genre = chosen.normalizedGenres?.[0]; const query = genreSearchTerm(genre) || chosen.author || chosen.title; const candidates = await catalogueSearch(query, 30, Boolean(genre)); const books = candidates.filter((book) => book.id !== chosen.id && !isSameSeries(book, chosen) && !isEditorialTitle(book)).map((book) => ({ ...book, similarityScore: score(book, chosen), popularityScore: readerPopularity(book) })).filter((book) => book.similarityScore > 0 || (book.sources.includes('Google Books') && book.normalizedGenres.length > 0)).sort((a, b) => b.popularityScore - a.popularityScore || b.similarityScore - a.similarityScore).slice(0, 6); res.json({ books }); } catch (error) { res.status(502).json({ error: error.message }); } });

app.post('/api/auth/register', requireDatabase, async (req, res) => { const email = String(req.body.email || '').toLowerCase().trim(); const password = String(req.body.password || ''); if (!/^\S+@\S+\.\S+$/.test(email) || password.length < 8) return res.status(400).json({ error: 'Use a valid email and a password with at least 8 characters.' }); try { const passwordHash = await bcrypt.hash(password, 12); const result = await db.query('INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id, email', [email, passwordHash]); const user = result.rows[0]; res.status(201).json({ user, token: userToken(user) }); } catch (error) { if (error.code === '23505') return res.status(409).json({ error: 'An account with that email already exists.' }); res.status(500).json({ error: 'Could not create your account.' }); } });
app.post('/api/auth/login', requireDatabase, async (req, res) => { const email = String(req.body.email || '').toLowerCase().trim(); const result = await db.query('SELECT id, email, password_hash FROM users WHERE email = $1', [email]); const user = result.rows[0]; if (!user || !(await bcrypt.compare(String(req.body.password || ''), user.password_hash))) return res.status(401).json({ error: 'Incorrect email or password.' }); res.json({ user: { id: user.id, email: user.email }, token: userToken(user) }); });
app.get('/api/me', requireDatabase, requireUser, async (req, res) => { const result = await db.query('SELECT book_id, book, rating, saved_at FROM saved_books WHERE user_id = $1 ORDER BY saved_at DESC', [req.user.id]); res.json({ user: { id: req.user.id, email: req.user.email }, saved: result.rows }); });
app.post('/api/saved', requireDatabase, requireUser, async (req, res) => { const book = req.body.book; if (!book?.id || !book.title) return res.status(400).json({ error: 'A valid book is required.' }); const result = await db.query('INSERT INTO saved_books (user_id, book_id, book) VALUES ($1, $2, $3) ON CONFLICT (user_id, book_id) DO UPDATE SET book = EXCLUDED.book RETURNING book_id, book, rating, saved_at', [req.user.id, book.id, book]); res.status(201).json({ saved: result.rows[0] }); });
app.patch('/api/saved/:bookId/rating', requireDatabase, requireUser, async (req, res) => { const rating = Number(req.body.rating); if (!Number.isInteger(rating) || rating < 1 || rating > 5) return res.status(400).json({ error: 'Rating must be a whole number from 1 to 5.' }); const result = await db.query('UPDATE saved_books SET rating = $1 WHERE user_id = $2 AND book_id = $3 RETURNING book_id, book, rating', [rating, req.user.id, req.params.bookId]); if (!result.rowCount) return res.status(404).json({ error: 'Saved book not found.' }); res.json({ saved: result.rows[0] }); });
app.delete('/api/saved/:bookId', requireDatabase, requireUser, async (req, res) => { await db.query('DELETE FROM saved_books WHERE user_id = $1 AND book_id = $2', [req.user.id, req.params.bookId]); res.status(204).end(); });

app.use(express.static(path.join(__dirname, 'dist')));
app.get('*splat', (req, res) => res.sendFile(path.join(__dirname, 'dist', 'index.html')));
app.listen(PORT, () => console.log(`Leafmark API is running at http://localhost:${PORT}`));
