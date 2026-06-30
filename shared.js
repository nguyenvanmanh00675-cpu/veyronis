/* =========================================================
   shared.js — Dùng chung cho toàn bộ website Veyronis
   Nhúng file này vào MỌI trang bằng:
   <script src="shared.js"></script>
   (đặt TRƯỚC script riêng của từng trang)
========================================================= */

const HISTORY_DAYS_LIMIT = 15;

/* ============== TÀI KHOẢN ĐANG ĐĂNG NHẬP ============== */
function getCurrentUser() {
    return JSON.parse(localStorage.getItem('currentUser'));
}
function getCurrentUserId() {
    const u = getCurrentUser();
    if (!u) return null;
    return u.id || u.email || u.phone;
}

/* ============== LỊCH SỬ MUA HÀNG / NẠP TIỀN (15 NGÀY) ============== */
function getPurchaseKey() {
    const uid = getCurrentUserId();
    return uid ? `purchaseHistory_${uid}` : null;
}
function getDepositKey() {
    const uid = getCurrentUserId();
    return uid ? `depositHistory_${uid}` : null;
}
function filterRecent(list) {
    const cutoff = Date.now() - HISTORY_DAYS_LIMIT * 24 * 60 * 60 * 1000;
    return list.filter(item => item.timestamp >= cutoff);
}
function addPurchaseHistory(serviceName, price) {
    const key = getPurchaseKey();
    if (!key) return false;
    let list = JSON.parse(localStorage.getItem(key) || '[]');
    list.unshift({ name: serviceName, amount: price, timestamp: Date.now() });
    list = filterRecent(list);
    localStorage.setItem(key, JSON.stringify(list));
    return true;
}
function addDepositHistory(amount, name = "Nạp tiền vào tài khoản") {
    const key = getDepositKey();
    if (!key) return false;
    let list = JSON.parse(localStorage.getItem(key) || '[]');
    list.unshift({ name: name, amount: amount, timestamp: Date.now() });
    list = filterRecent(list);
    localStorage.setItem(key, JSON.stringify(list));
    return true;
}
function formatVND(num) {
    return Number(num).toLocaleString('vi-VN') + 'đ';
}

/* ============== VÍ TIỀN (SỐ DƯ) ============== */
function getBalance() {
    return parseInt(localStorage.getItem('userBalance') || '0', 10);
}
function setBalance(value) {
    localStorage.setItem('userBalance', value);
}
/* Trừ tiền trong ví. Trả về true nếu đủ tiền & trừ thành công, false nếu không đủ. */
function deductBalance(amount) {
    const bal = getBalance();
    if (bal < amount) return false;
    setBalance(bal - amount);
    return true;
}

/* ============== TRẠNG THÁI BẢO TRÌ DỊCH VỤ (ADMIN ĐIỀU KHIỂN) ==============
   Lưu dưới dạng object: { "svc_id": true/false }
   true (hoặc không có key) = Đang hoạt động
   false = Đang bảo trì
*/
const SERVICE_STATUS_KEY = 'serviceStatus';
function getServiceStatusMap() {
    return JSON.parse(localStorage.getItem(SERVICE_STATUS_KEY) || '{}');
}
function isServiceActive(serviceId) {
    const map = getServiceStatusMap();
    return map[serviceId] !== false; // mặc định là Hoạt Động nếu chưa thiết lập
}
function setServiceStatus(serviceId, active) {
    const map = getServiceStatusMap();
    map[serviceId] = active;
    localStorage.setItem(SERVICE_STATUS_KEY, JSON.stringify(map));
}

/* ============== TOAST THÔNG BÁO DÙNG CHUNG ==============
   Yêu cầu trang phải có sẵn:
   <div id="toast-notification" class="toast-hidden">
       <span id="toast-message">Thông báo</span>
   </div>
   và CSS .toast-hidden / .toast-show (xem phần CSS mẫu cuối file).
*/
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

/* CSS MẪU CẦN CÓ TRONG <style> CỦA TỪNG TRANG DÙNG showToast():

#toast-notification {
    position: fixed;
    top: 20px;
    right: 20px;
    background-color: #050505;
    color: #fff;
    border: 2px solid #00ff7f;
    padding: 15px 25px;
    border-radius: 8px;
    box-shadow: 0 0 15px rgba(0, 255, 127, 0.4);
    font-weight: bold;
    font-family: Arial, sans-serif;
    z-index: 9999;
    transition: opacity 0.5s ease, transform 0.5s ease;
    max-width: 320px;
}
.toast-hidden { opacity: 0; transform: translateY(-20px); pointer-events: none; }
.toast-show { opacity: 1; transform: translateY(0); }

*/
