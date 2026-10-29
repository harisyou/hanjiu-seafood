export type OptionalStockPhotoTask={index:number;stockId:string;photoToken:string;photo:File};
export type OptionalStockPhotoOperations={
  prepare:(photo:File)=>Promise<Blob>;
  upload:(path:string,blob:Blob)=>Promise<void>;
  link:(stockId:string,path:string)=>Promise<void>;
};
export function weightedStockPhotoPath(stockId:string,photoToken:string):string;
export function isExistingStorageObjectError(error:unknown):boolean;
export function saveOptionalStockPhotos(tasks:OptionalStockPhotoTask[],operations:OptionalStockPhotoOperations):Promise<number[]>;
