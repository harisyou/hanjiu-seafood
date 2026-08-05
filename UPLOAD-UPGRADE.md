# 圖片上傳系統升級

已完成：

- 中文檔名與特殊字元自動改成 UUID
- 支援 JPG / PNG / WebP
- HEIC / HEIF 會顯示明確提示
- 上傳前自動縮小至最寬 1800px
- 自動轉成 WebP
- 圖片即時預覽
- 拖曳上傳
- 編輯商品更換圖片後會清理舊圖
- 刪除商品時同步清理 Storage 圖片
- 前台圖片 lazy loading 與失敗保護

部署方式：

1. 解壓縮本 ZIP。
2. 將內容覆蓋到本機 hanjiu-seafood 專案。
3. GitHub Desktop Commit。
4. Push origin。
5. 等待 Vercel 自動部署。