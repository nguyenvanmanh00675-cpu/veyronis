// =====================================================================
// SHARED.JS — Dùng chung cho toàn bộ site Veyronis
// Cần load thư viện Supabase TRƯỚC file này:
// <script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script>
// <script src="shared.js"></script>
// =====================================================================

const SUPABASE_URL = 'https://lxdoaaygwvsrbqendevw.supabase.co';
const SUPABASE_KEY = 'sb_publishable_g1ov_vwAvrkSwf9J5hKgrg_pSWn57dl';
const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

// ---------------------------------------------------------------------
// USER / SESSION (session được lưu ở localStorage bởi taikhoan.html
// sau khi đăng nhập qua Supabase Auth — đây chỉ là cache đọc lại)
// ---------------------------------------------------------------------
function getCurrentUser() {
    try {
        return JSON.parse(localStorage.getItem('currentUser'));
    } catch (e) {
        return null;
    }
}
function getCurrentUserId() {
    const u = getCurrentUser();
    return u ? u.id : null;
}

// ---------------------------------------------------------------------
// TOAST THÔNG BÁO DÙNG CHUNG
// ---------------------------------------------------------------------
function showToast(message, borderColor = "#00ff7f") {
    const toast = document.getElementById('toast-notification');
    const toastMsg = document.getElementById('toast-message');
    if (!toast || !toastMsg) { console.log(message); return; }

    toastMsg.innerText = message;
    toast.style.borderColor = borderColor;
    toast.style.boxShadow = `0 0 15px ${borderColor}66`;

    toast.classList.remove('toast-hidden');
    toast.classList.add('toast-show');

    clearTimeout(window.__toastTimer);
    window.__toastTimer = setTimeout(() => {
        toast.classList.remove('toast-show');
        toast.classList.add('toast-hidden');
    }, 3000);
}

// ---------------------------------------------------------------------
// ĐỊNH DẠNG TIỀN / NGÀY GIỜ
// ---------------------------------------------------------------------
function formatVND(num) {
    return Number(num || 0).toLocaleString('vi-VN') + 'đ';
}
function formatDateVN(ts) {
    const d = new Date(ts);
    return d.toLocaleString('vi-VN', {
        day: '2-digit', month: '2-digit', year: 'numeric',
        hour: '2-digit', minute: '2-digit'
    });
}

// ---------------------------------------------------------------------
// SỐ DƯ (BALANCE) — lưu trên Supabase, có cache đồng bộ để dùng nhanh
// ---------------------------------------------------------------------
let __balanceCache = 0;

async function fetchBalance() {
    const uid = getCurrentUserId();
    if (!uid) { __balanceCache = 0; return 0; }
    const { data, error } = await sb.from('profiles').select('balance').eq('id', uid).single();
    if (error) { console.error('fetchBalance:', error); return __balanceCache; }
    __balanceCache = data.balance || 0;
    return __balanceCache;
}

// Trả về số dư đã cache gần nhất (đồng bộ). Gọi await fetchBalance() trước
// nếu cần số liệu mới nhất ngay lúc đó (ví dụ ngay trước khi thanh toán).
function getBalance() {
    return __balanceCache;
}

// ---------------------------------------------------------------------
// MUA DỊCH VỤ — trừ tiền + lưu lịch sử, thực hiện atomic phía server (RPC)
// ---------------------------------------------------------------------
async function purchaseService(serviceName, amount) {
    const { data, error } = await sb.rpc('make_purchase', {
        p_service_name: serviceName,
        p_amount: amount
    });
    if (error) {
        console.error('purchaseService:', error);
        if ((error.message || '').includes('THIEU_DISCORD_ID')) {
            return 'THIEU_DISCORD_ID';
        }
        return false;
    }
    await fetchBalance();
    return data === true;
}

// ---------------------------------------------------------------------
// NẠP THẺ CÀO / CHUYỂN KHOẢN — đưa vào hàng chờ, Admin duyệt mới cộng tiền
// ---------------------------------------------------------------------
async function submitCardToQueue(network, value, code, seri) {
    const { data, error } = await sb.rpc('submit_card', {
        p_network: network, p_value: value, p_code: code, p_seri: seri
    });
    if (error) { console.error('submitCardToQueue:', error); return false; }
    return !!data;
}

async function submitBankClaim(amount, memo) {
    const { data, error } = await sb.rpc('submit_bank_claim', {
        p_amount: amount, p_memo: memo
    });
    if (error) { console.error('submitBankClaim:', error); return false; }
    return !!data;
}

// ---------------------------------------------------------------------
// LỊCH SỬ MUA HÀNG / NẠP TIỀN CỦA CHÍNH USER
// ---------------------------------------------------------------------
async function fetchMyPurchaseHistory(limit = 30) {
    const uid = getCurrentUserId();
    if (!uid) return [];
    const { data, error } = await sb.from('purchases')
        .select('service_name, amount, created_at')
        .eq('user_id', uid)
        .order('created_at', { ascending: false })
        .limit(limit);
    if (error) { console.error(error); return []; }
    return data || [];
}

async function fetchMyDepositHistory(limit = 30) {
    const uid = getCurrentUserId();
    if (!uid) return [];
    const { data, error } = await sb.from('deposits')
        .select('amount, note, created_at')
        .eq('user_id', uid)
        .order('created_at', { ascending: false })
        .limit(limit);
    if (error) { console.error(error); return []; }
    return data || [];
}

// ---------------------------------------------------------------------
// TRẠNG THÁI DỊCH VỤ (HOẠT ĐỘNG / BẢO TRÌ) — lưu trên Supabase
// ---------------------------------------------------------------------
let __serviceStatusCache = {};

async function fetchServiceStatus() {
    const { data, error } = await sb.from('service_status').select('service_id, is_active');
    if (error) { console.error('fetchServiceStatus:', error); return; }
    __serviceStatusCache = {};
    (data || []).forEach(row => { __serviceStatusCache[row.service_id] = row.is_active; });
}

function isServiceActive(serviceId) {
    if (!(serviceId in __serviceStatusCache)) return true; // mặc định Hoạt Động nếu chưa có dữ liệu
    return __serviceStatusCache[serviceId] !== false;
}

async function setServiceStatus(serviceId, isActive) {
    const { data, error } = await sb.rpc('admin_set_service_status', {
        p_service_id: serviceId, p_active: isActive
    });
    if (error) { console.error('setServiceStatus:', error); return false; }
    if (data) __serviceStatusCache[serviceId] = isActive;
    return !!data;
}

// ---------------------------------------------------------------------
// GIÁ DỊCH VỤ — lưu trên Supabase (bảng service_prices), do Admin chỉnh.
// Các trang dịch vụ nên gọi getServicePrice(id, giaMacDinh) để lấy giá
// hiện tại: nếu Admin đã set giá riêng thì dùng giá đó, còn không thì
// dùng giaMacDinh viết sẵn trong HTML.
// ---------------------------------------------------------------------
let __servicePriceCache = {};

async function fetchServicePrices() {
    const { data, error } = await sb.from('service_prices').select('service_id, price');
    if (error) { console.error('fetchServicePrices:', error); return; }
    __servicePriceCache = {};
    (data || []).forEach(row => { __servicePriceCache[row.service_id] = Number(row.price); });
}

function getServicePrice(serviceId, fallbackPrice) {
    if (serviceId in __servicePriceCache) return __servicePriceCache[serviceId];
    return fallbackPrice;
}

async function adminSetServicePrice(serviceId, price) {
    const { data, error } = await sb.rpc('admin_set_service_price', {
        p_service_id: serviceId, p_price: price
    });
    if (error) { console.error('adminSetServicePrice:', error); return false; }
    if (data) __servicePriceCache[serviceId] = Number(price);
    return !!data;
}

// ---------------------------------------------------------------------
// YÊU CẦU ID DISCORD TRƯỚC KHI MUA DỊCH VỤ — nếu tài khoản chưa nhập ID
// Discord, ADMIN sẽ không có cách nào liên hệ giao dịch vụ, nên chặn
// mua hàng và nhắc người dùng thêm ID Discord (trong taikhoan.html).
// ---------------------------------------------------------------------
const DISCORD_ID_REQUIRED_MSG = "Hãy Thêm ID Discord Tài Khoản Của Người Dùng Để Sử Dụng Dịch Vụ, Nếu Không Có ID Discord thì ADMIN sẽ không Liên Hệ Được";

async function hasDiscordIdLinked() {
    const id = await fetchMyDiscordId();
    return !!(id && id.trim().length > 0);
}

// ---------------------------------------------------------------------
// DISCORD ID LIÊN KẾT — lưu trên Supabase (bảng profiles.discord_id) để
// ADMIN thấy được khi khách mua dịch vụ. Đổi ID Discord phải re-auth lại
// bằng mật khẩu đăng nhập (xem taikhoan.html) trước khi gọi updateDiscordId.
// ---------------------------------------------------------------------
async function fetchMyDiscordId() {
    const uid = getCurrentUserId();
    if (!uid) return null;
    const { data, error } = await sb.from('profiles').select('discord_id').eq('id', uid).single();
    if (error) { console.error('fetchMyDiscordId:', error); return null; }
    return data ? data.discord_id : null;
}

// Lưu ý: hàm này chỉ nên gọi SAU KHI đã xác thực lại mật khẩu của user
// (vd: await sb.auth.signInWithPassword({ email, password }) không lỗi).
async function updateDiscordId(discordId) {
    const { data, error } = await sb.rpc('update_discord_id', { p_discord_id: discordId });
    if (error) { console.error('updateDiscordId:', error); return false; }
    return data === true;
}

// Các hàm cũ dùng localStorage (giữ lại để tương thích ngược, không còn
// dùng để gửi thông tin cho Admin nữa — hãy dùng fetchMyDiscordId/updateDiscordId ở trên).
function saveDiscordID(uid, discordId) {
    localStorage.setItem(`discord_id_${uid}`, discordId);
}
function getDiscordID(uid) {
    return localStorage.getItem(`discord_id_${uid}`) || 'Chưa liên kết';
}

// ---------------------------------------------------------------------
// KHỞI TẠO DỮ LIỆU DÙNG CHUNG MỖI KHI TẢI TRANG
// Các trang có thể "await window.sharedDataReady" để chắc chắn dữ liệu
// (trạng thái dịch vụ + số dư) đã sẵn sàng trước khi render giao diện.
// ---------------------------------------------------------------------
window.sharedDataReady = (async function initSharedData() {
    await Promise.all([fetchServiceStatus(), fetchServicePrices()]);
    if (getCurrentUser()) await fetchBalance();
})();

// =======================================================================
// ADMIN — TÌM USER, CỘNG/TRỪ TIỀN, DUYỆT THẺ/CHUYỂN KHOẢN, THỐNG KÊ
// =======================================================================
async function adminIsCurrentUserAdmin() {
    if (!getCurrentUser()) return false;
    const { data, error } = await sb.rpc('is_admin');
    if (error) { console.error('adminIsCurrentUserAdmin:', error); return false; }
    return data === true;
}

async function adminSearchUsers(query) {
    const { data, error } = await sb.rpc('search_users', { p_query: query || '' });
    if (error) { console.error('adminSearchUsers:', error); return []; }
    return data || [];
}

async function adminAdjustBalance(userId, amount, note) {
    const { data, error } = await sb.rpc('admin_adjust_balance', {
        p_user_id: userId, p_amount: amount, p_note: note || ''
    });
    if (error) { console.error('adminAdjustBalance:', error); return false; }
    return data === true;
}

async function adminFetchPendingCards() {
    // Lưu ý: card_queue có 2 khóa ngoại trỏ tới profiles (user_id và reviewed_by),
    // nên phải chỉ rõ dùng khóa ngoại "user_id" để Supabase không báo lỗi
    // "ambiguous relationship" (lỗi này trước đây bị nuốt âm thầm khiến bảng
    // luôn hiện rỗng dù badge vẫn đếm đúng số đơn đang chờ).
    const { data, error } = await sb.from('card_queue')
        .select('*, profiles!user_id(email, phone)')
        .eq('status', 'pending')
        .order('created_at', { ascending: false });
    if (error) { console.error('adminFetchPendingCards:', error); return null; }
    return data || [];
}

async function adminFetchCardHistory(limit = 30) {
    const { data, error } = await sb.from('card_queue')
        .select('*, profiles!user_id(email, phone)')
        .neq('status', 'pending')
        .order('reviewed_at', { ascending: false })
        .limit(limit);
    if (error) { console.error('adminFetchCardHistory:', error); return null; }
    return data || [];
}

async function adminReviewCard(cardId, approve, note) {
    const { data, error } = await sb.rpc('admin_review_card', {
        p_card_id: cardId, p_approve: approve, p_note: note || null
    });
    if (error) { console.error('adminReviewCard:', error); return false; }
    return data === true;
}

async function adminFetchAllPurchases(limit = 50) {
    // Lấy kèm discord_id của người mua để Admin biết cách liên hệ khách qua Discord
    const { data, error } = await sb.from('purchases')
        .select('*, profiles(email, phone, discord_id)')
        .order('created_at', { ascending: false })
        .limit(limit);
    if (error) { console.error('adminFetchAllPurchases:', error); return []; }
    return data || [];
}

async function adminFetchStats() {
    const [{ count: userCount }, { count: pendingCount }, purchases] = await Promise.all([
        sb.from('profiles').select('*', { count: 'exact', head: true }),
        sb.from('card_queue').select('*', { count: 'exact', head: true }).eq('status', 'pending'),
        sb.from('purchases').select('amount')
    ]);
    const totalRevenue = (purchases.data || []).reduce((sum, p) => sum + Number(p.amount || 0), 0);
    return {
        userCount: userCount || 0,
        pendingCount: pendingCount || 0,
        totalRevenue
    };
}
