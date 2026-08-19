export interface DatabaseAdapter {
  inspectSchema(resourceId:string):Promise<unknown>;
  applyMigrations(resourceId:string,migrations:{name:string;sql:string}[]):Promise<unknown>;
  validateMigration(resourceId:string,migration:string):Promise<unknown>;
}
