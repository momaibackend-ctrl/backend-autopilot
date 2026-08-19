import { UnsupportedOperation } from '../../../core/src/errors.js';

export interface SupabaseAdapter {applyMigrations(resourceId:string,migrations:string[]):Promise<never>;inspectSchema(resourceId:string):Promise<never>;inspectAuth(resourceId:string):Promise<never>;inspectStorage(resourceId:string):Promise<never>;validateRls(resourceId:string):Promise<never>;listDatabaseFunctions(resourceId:string):Promise<never>;deployEdgeFunction(resourceId:string,name:string):Promise<never>;}
export class DisabledSupabaseAdapter implements SupabaseAdapter {
  async applyMigrations(_resourceId:string,_migrations:string[]):Promise<never>{throw new UnsupportedOperation('Supabase mutation requires an explicit staging resource and runtime credential');}
  async inspectSchema(_resourceId:string):Promise<never>{throw new UnsupportedOperation('Supabase inspection is not configured');}
  async inspectAuth(_resourceId:string):Promise<never>{throw new UnsupportedOperation('Supabase Auth inspection is not configured');}
  async inspectStorage(_resourceId:string):Promise<never>{throw new UnsupportedOperation('Supabase Storage inspection is not configured');}
  async validateRls(_resourceId:string):Promise<never>{throw new UnsupportedOperation('Supabase RLS inspection is not configured');}
  async listDatabaseFunctions(_resourceId:string):Promise<never>{throw new UnsupportedOperation('Supabase database function inspection is not configured');}
  async deployEdgeFunction(_resourceId:string,_name:string):Promise<never>{throw new UnsupportedOperation('Supabase Edge Function deployment is not configured');}
}
