export class NotesService {
  constructor(db) { this.db = db; }
  async create(ownerId, input) {
    requireOwner(ownerId); if (!input.title?.trim()) throw typed('VALIDATION_ERROR', 400);
    const { rows } = await this.db.query('INSERT INTO notes (owner_id,title,body) VALUES ($1,$2,$3) RETURNING *', [ownerId,input.title,input.body ?? '']); return rows[0];
  }
  async list(ownerId) { requireOwner(ownerId); return (await this.db.query('SELECT * FROM notes WHERE owner_id=$1 ORDER BY created_at DESC',[ownerId])).rows; }
  async get(ownerId,id) { requireOwner(ownerId); const note=(await this.db.query('SELECT * FROM notes WHERE id=$1 AND owner_id=$2',[id,ownerId])).rows[0]; if(!note)throw typed('NOT_FOUND',404); return note; }
  async update(ownerId,id,input) { requireOwner(ownerId); const note=(await this.db.query('UPDATE notes SET title=COALESCE($3,title),body=COALESCE($4,body),updated_at=now() WHERE id=$1 AND owner_id=$2 RETURNING *',[id,ownerId,input.title,input.body])).rows[0]; if(!note)throw typed('NOT_FOUND',404); return note; }
  async remove(ownerId,id) { requireOwner(ownerId); const count=(await this.db.query('DELETE FROM notes WHERE id=$1 AND owner_id=$2',[id,ownerId])).rowCount; if(!count)throw typed('NOT_FOUND',404); }
}
function requireOwner(value){if(!value)throw typed('UNAUTHORIZED',401);}
function typed(code,status){return Object.assign(new Error(code),{code,status});}
