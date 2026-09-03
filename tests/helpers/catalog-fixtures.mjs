export const ids = { p1: '10000000-0000-4000-8000-000000000001', p2: '10000000-0000-4000-8000-000000000002', p3: '10000000-0000-4000-8000-000000000003', hidden: '10000000-0000-4000-8000-000000000004', sold: '10000000-0000-4000-8000-000000000005', category: '20000000-0000-4000-8000-000000000001' };
const product = (id, name, status = 'available') => ({ id, name, status, category_id: ids.category, description: '測試商品介紹', texture_description: '肉質細緻', cooking: '清蒸', storage_instructions: '冷藏保存', processing_enabled: true, featured: false, sort_order: 100, image_url: null });
export function fixtures() {
  return {
    products: [product(ids.p1,'馬頭魚'), product(ids.p2,'黑喉'), product(ids.p3,'黃雞魚'), product(ids.hidden,'隱藏魚','hidden'), product(ids.sold,'暫停販售魚','sold_out')],
    product_variants: [
      { id:'30000000-0000-4000-8000-000000000001', product_id:ids.p1, name:'438g', price:499, inventory:10, preorder_enabled:true, active:true, sort_order:0 },
      { id:'30000000-0000-4000-8000-000000000002', product_id:ids.p2, name:'526g', price:12999, inventory:10, preorder_enabled:false, active:true, sort_order:0 },
      { id:'30000000-0000-4000-8000-000000000003', product_id:ids.p3, name:'713g', price:1080, inventory:0, preorder_enabled:true, active:true, sort_order:0 }
    ],
    product_categories:[{ id:ids.category, name:'海魚', active:true, sort_order:0 }, ...['蝦類','貝類','軟絲小卷','其他海鮮'].map((name,index)=>({id:`20000000-0000-4000-8000-00000000000${index+2}`,name,active:true,sort_order:index+1}))],
    processing_options:[{ id:'scale', name:'去鱗', active:true, sort_order:0 }],
    processing_presets:[{ id:'none', name:'不處理', description:'完整魚身', active:true, sort_order:0 }],
    processing_preset_options:[],
    product_processing_options:[ids.p1,ids.p2,ids.p3].map(product_id=>({ product_id, processing_option_id:'scale', active:true, recommended:false, sort_order:0 })),
    product_processing_presets:[ids.p1,ids.p2,ids.p3].map(product_id=>({ product_id, preset_id:'none', active:true, is_default:true, recommended:false, sort_order:0 })),
    product_images:[0,1].map((sort_order)=>({ id:`40000000-0000-4000-8000-00000000000${sort_order+1}`, product_id:ids.p1, storage_bucket:null, storage_path:null, legacy_url:`http://127.0.0.1:54329/image/${sort_order}`, alt_text:`魚貨照片 ${sort_order+1}`, sort_order, is_primary:sort_order===0 })),
    product_faqs:[{ id:'50000000-0000-4000-8000-000000000001', product_id:ids.p1, question:'適合煮湯嗎？', answer:'適合。', sort_order:0, active:true },{ id:'50000000-0000-4000-8000-000000000002', product_id:ids.p1, question:'停用問答', answer:'不應顯示', sort_order:1, active:false }],
    fish_catalog:[]
  };
}
