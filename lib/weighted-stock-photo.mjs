export function weightedStockPhotoPath(stockId, photoToken) {
  return `weighted-stock/${stockId}/${photoToken}.webp`;
}

export function isExistingStorageObjectError(error) {
  const message=String(error?.message??error??'').toLowerCase();
  return error?.statusCode===409 || error?.status===409 || message.includes('already exists') || message.includes('409');
}

export async function saveOptionalStockPhotos(tasks, operations) {
  const failed=[];
  for (const task of tasks) {
    const path=weightedStockPhotoPath(task.stockId,task.photoToken);
    try {
      const blob=await operations.prepare(task.photo);
      try {await operations.upload(path,blob);}
      catch (error) {if(!isExistingStorageObjectError(error))throw error;}
      await operations.link(task.stockId,path);
    } catch {failed.push(task.index);}
  }
  return failed;
}
