import db from "../config/db.js";
import validateFields from "../validation.js";
import { queryDB,  insertRecord, updateRecord } from '../dbUtils.js';
import { mergeParam, formatNumber } from '../utils.js';
import moment from "moment";
import Stripe from "stripe";
import dotenv from 'dotenv';
import generateUniqueId from "generate-unique-id";
dotenv.config();

export const createIntent = async (req, resp) => {
    const {rider_name, rider_email, amount, currency, booking_id, building_name, street_name='', unit_no, area, emirate } = mergeParam(req);
    const { isValid, errors } = validateFields(mergeParam(req), {
        rider_name  : ["required"], 
        rider_email : ["required"],
        amount      : ["required"],
        currency    : ["required"],
        
        // 12 March ko add hua hai
        booking_id    : ["required"],
        building_name : ["required"],
        // street_name   : ["required"],
        unit_no       : ["required"],
        area          : ["required"],
        emirate       : ["required"],
    });
    if (!isValid) return resp.json({ status: 0, code: 422, message: errors });

    try {
        const stripe  = new Stripe(process.env.STRIPE_SECRET_KEY);
        // const user = await findCustomerByEmail(rider_email);
        // let customerId;
        // if(user.success){
        //     customerId = user.customer_id;
        // }else{
        //     const customer = await stripe.customers.create({
        //         name: rider_name,
        //         address: {
        //             line1: "476 Yudyog Vihar Phase - V",
        //             postal_code: "122016",
        //             city: "Gurugram",
        //             state: "Haryana",
        //             country: "IND",
        //         },
        //         email: rider_email,
        //     });
        //     customerId = customer.id;
        // }
        const customer = await stripe.customers.create({
            name    : rider_name,
            address : {
                line1       : `${building_name} ${street_name}`, //"D55-PBU - Dubai Production City",
                postal_code : unit_no,                       // D55-PBU
                city        : area,                     //Dubai Production City
                state       : emirate,                 //Dubai
                country     : "United Arab Emirates",
            },
            email: rider_email,
            description : `This booking Id : ${booking_id} for POD Booking.`
        });
        let customerId = customer.id;
        
        const ephemeralKey = await stripe.ephemeralKeys.create(
            { customer   : customerId },
            { apiVersion : '2025-02-24.acacia' } //'2025-02-24.acacia'
        );
        const paymentIntent = await stripe.paymentIntents.create({
            amount                    : amount < 200 ? 200 : Math.floor(amount),
            currency                  : currency,
            customer                  : customerId,
            automatic_payment_methods : {
                enabled : true,
            },
            // payment_method_types   : ["card"],
            use_stripe_sdk         : true,
            setup_future_usage     : 'off_session',
            payment_method_options : {
                card : {
                    request_three_d_secure : 'any',
                },
            },
            // confirmation_method: "automatic",
            // off_session : true,
            confirm     : true,
            return_url  : "https://plusx.shunyaekai.com/payment-success", 
        });

        const returnData = {
            paymentIntentId     : paymentIntent.id,
            paymentIntentSecret : paymentIntent.client_secret,
            ephemeralKey        : ephemeralKey.secret,
            customer            : customerId,
            publishableKey      : process.env.STRIPE_PUBLISER_KEY,
        };
        return resp.json({
            message : ["Payment Intent Created successfully!"],
            data    : returnData,
            status  : 1,
            code    : 200,
        });
    } catch (err) {
        console.error('Error creating payment intent:', err);
        return resp.status(500).json({
            message : ["Error creating payment intent"],
            error   : err.message,
            status  : 0,
            code    : 500,
        });
    }
};

export const createAutoDebit = async (customerId, paymentMethodId, totalAmount) => {
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  
    try {
        const paymentIntent = await stripe.paymentIntents.create({
            amount: totalAmount < 200 ? 200 : Math.floor(totalAmount),
            currency: 'aed',
            customer: customerId,
            payment_method: paymentMethodId,
            off_session: true,
            confirm: true,
        });
  
        return {
            message: "Payment completed successfully!",
            status: 1,
            code: 200,
            paymentIntent,
        };
    } catch (err) {
        console.error('Error processing off-session payment:', err);
        return {
            message: "Error processing payment",
            error: err.message,
            status: 0,
            code: 500,
        };
    }
};

export const addCardToCustomer = async (req, resp) => {
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
    const { rider_email, rider_name } = mergeParam(req);

    try {
        const user = await findCustomerByEmail(rider_email);
        let customerId;
        
        if(user.success){
            customerId = user.customer_id;
        }else{
            const customer = await stripe.customers.create({
                name: rider_name,
                email: rider_email,
            });
            customerId = customer.id;
        }
        
        const setupIntent = await stripe.setupIntents.create({
            customer: customerId,
            payment_method_types: ['card'],
        });

        const ephemeralKey = await stripe.ephemeralKeys.create(
            { customer: customerId },
            {apiVersion: '2024-04-10'}
        );
    
        resp.json({ 
            status:1, 
            code:200, 
            message:['Setup intent created successfully!'],
            setup_payment_intent_id: setupIntent.id,
            client_secret: setupIntent.client_secret,
            ephemeralKey: ephemeralKey.secret,
            customer: customerId,
            publishableKey: process.env.STRIPE_PUBLISER_KEY,
        });
    } catch (error) {
        console.error('Error adding card to customer:', error);
        resp.json({ status:0, code:500, message: error.message });
    }
};

export const customerCardsList = async (req, resp) => {
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
    const { rider_email } = mergeParam(req);
    try{
        const user = await findCustomerByEmail(rider_email);
        if(!user.success) return resp.json({status: 1, code:422, message: 'No card found, Please add a card.'});
        
        const customerId = user.customer_id;
        const cardDetailsList = [];
        
        const customerCards = await stripe.paymentMethods.list({
            customer: customerId,
            type: 'card',
        });

        customerCards.data.forEach(method => {
            const cardDetails = {
              paymentMethodId   : method.id,
              name              : method.billing_details.name || user.name,
              last4             : method.card.last4,
              exp_month         : method.card.exp_month,
              exp_year          : method.card.exp_year,
              brand             : method.card.brand
            };
          
            cardDetailsList.push(cardDetails);
        });
    
        return resp.json({
            status:1,
            code:200,
            message: ["Card list fetch successfully"],
            total: customerCards.data.length, 
            card_details: cardDetailsList,
        });
    }catch(error){
        console.error('Error adding card to customer:', error);
        resp.json({ status:0, code:500, message: error.message });
    }

};

export const removeCard = async (req, resp) => {
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
    const { payment_method_id } = req.body;
    if (!payment_method_id) return resp.status(400).json({ status: 0, code: 422, message: ['Payment Method ID is required.']});
    
    try {
        const detachedPaymentMethod = await stripe.paymentMethods.detach(payment_method_id);

        return resp.json({
            status: 1,
            code: 200,
            message: ['Payment Method removed successfully.'],
            paymentMethodId: detachedPaymentMethod.id,
        });
    } catch (error) {
        console.error('Error detaching card:', error);

        return resp.status(500).json({
            status: 0,
            code: 422,
            message: ['Error removing payment method.'],
            error: error.message,
        });
    }
};

export const autoPay = async (req, resp) => {
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
    const {customer_id, payment_method_id,amount } = mergeParam(req);

    try{
        const paymentIntent = await stripe.paymentIntents.create({
            amount: amount * 100,
            currency: 'aed',
            customer: customer_id,
            payment_method: payment_method_id,
            off_session: true,
            confirm: true,
        });
  
        return resp.json({
            message: "Payment from saved card completed successfully!",
            status: 1,
            code: 200,
            paymentIntent,
        });
    }catch(err){
        console.error('Error processing off-session payment:', err);
        return resp.status(500).json({
            message: "Error processing payment",
            error: err.message,
            status: 0,
            code: 500,
        });
    }
};

export const redeemCoupon = async (req, resp) => {
    const {rider_id, amount,booking_type, coupon_code } = mergeParam(req);
    
    const { isValid, errors } = validateFields(mergeParam(req), {
        rider_id     : ["required"], 
        amount       : ["required"],
        booking_type : ["required"],
        coupon_code  : ["required"],
    });
    const [[{ count }]] = await db.execute('SELECT COUNT(*) AS count FROM coupon WHERE coupan_code = ?',[coupon_code]);
    
    if (!isValid) return resp.json({ status: 0, code: 422, message: errors });
    if (count === 0) return resp.json({ status: 0, code: 422, message: ['The coupon code you entered does not exist in our records.'] });

    const coupon = await queryDB(`
        SELECT
            coupan_percentage, end_date, user_per_user, status, booking_for, 
            (SELECT count(id) FROM coupon_usage AS cu WHERE cu.coupan_code = coupon.coupan_code AND user_id = ?) as use_count
        FROM coupon
        WHERE coupan_code = ?
        LIMIT 1
    `, [rider_id, coupon_code]); 

    if (moment(coupon.end_date).isBefore(moment(), 'day') || coupon.status < 1){
        return resp.json({ errors: {coupon_code: ["Coupon is invalid or expired."]} });
    }else if(coupon.booking_for != booking_type){
        return resp.json({ errors: {booking_type: ["Coupon code is invalid for this booking type."]} });
    }else if(coupon.use_count >= coupon.user_per_user){
        return resp.json({ errors: {coupon_code: ["Coupon per user limit exceeded."]} });
    }

    const disAmount = (amount * coupon.coupan_percentage)/100;
    const finalAmount = amount - disAmount;
    // console.log(`Discount Amount: ${disAmount.toFixed(2)}`); // Log the discount amount
    // console.log(`Final Amount: ${finalAmount.toFixed(2)}`);

    return resp.json({
        message: [""],
        data: formatNumber(finalAmount),
        discount: formatNumber(disAmount),
        status: 1,
        code: 200
    });
};

export const createPortableChargerSubscription = async (req, resp) => {
    const {rider_id, request_id, payment_intent_id } = mergeParam(req);
    const { isValid, errors } = validateFields(mergeParam(req), {rider_id: ["required"] });
    if (!isValid) return resp.json({ status: 0, code: 422, message: errors });
    const currDate = moment().format('YYYY-MM-DD');
    const endDate = moment().add(30, 'days').format('YYYY-MM-DD');
    const count = await queryDB(`SELECT COUNT(*) as count FROM portable_charger_subscriptions WHERE rider_id=? AND total_booking < 10 AND expiry_date > ?`,[rider_id, currDate]);
    if(count > 0) return resp.json({status:1, code:200, message: ["You have alredy Subscription plan"]});
    
    const subscriptionId = `PCS-${generateUniqueId({length:12})}`;
    
    const createObj = {
        subscription_id: subscriptionId,
        rider_id: rider_id,
        amount: 0,
        expiry_date: endDate,
        booking_limit: 10,
        total_booking: 0,
        status: 1,
        payment_date: moment().format('YYYY-MM-DD HH:mm:ss'),
    }

    if(payment_intent_id && payment_intent_id.trim() != '' ){
        const paymentIntent = await stripe.paymentIntents.retrieve(payment_intent_id);
        const charge = await stripe.charges.retrieve(paymentIntent.latest_charge);
        const cardData = {
            brand:     charge.payment_method_details.card.brand,
            country:   charge.payment_method_details.card.country,
            exp_month: charge.payment_method_details.card.exp_month,
            exp_year:  charge.payment_method_details.card.exp_year,
            last_four: charge.payment_method_details.card.last4,
        };

        createObj.amount = charge.amount;  
        createObj.payment_intent_id = charge.payment_intent;  
        createObj.payment_method_id = charge.payment_method;  
        createObj.payment_cust_id = charge.customer;  
        createObj.charge_id = charge.id;  
        createObj.transaction_id = charge.payment_method_details.card.three_d_secure?.transaction_id || null;  
        createObj.payment_type = charge.payment_method_details.type;  
        createObj.payment_status = charge.status;  
        createObj.currency = charge.currency;  
        createObj.invoice_date = moment(charge.created).format('YYYY-MM-DD HH:mm:ss');
        createObj.receipt_url = charge.receipt_url;
        createObj.card_data = cardData;
    }

    const columns = Object.keys(createObj);
    const values = Object.values(createObj);
    const insert = await insertRecord('portable_charger_subscriptions', columns, values);

    const data = await queryDB(`
        SELECT 
            rider_email, rider_name
        FROM 
            portable_charger_subscriptions AS pcs
        LEFT JOIN
            riders AS r
        ON 
            r.rider_id = portable_charger_subscriptions.rider_id
        WHERE 
            pcs.subscription_id = ?
        LIMIT 1
    `, [subscriptionId]);
    const html = `<html>
        <body>
            <h4>Dear ${data.rider_name},</h4>
            <p>Thank you for subscribing to our EV Charging Plan with PlusX Electric App! We're excited to support your electric vehicle needs.</p>

            <p>Subscription Details: </p>

            <p>Plan: 10 EV Charging Sessions </p>
            <p>Duration: 30 days  </p>
            <p>Total Cost: 750 AED </p>

            <p>Important Information:</p>

            <p>Subscription Start Date: ${currDate}</p>
            <p>Subscription End Date: ${endDate}</p>

            <p>You can use your 10 charging sessions any time within the 30-day period. If you have any questions or need assistance, please do not hesitate to contact our support team.</p>

            <p>Thank you for choosing PlusX. We're committed to providing you with top-notch service and support.</p>

            <p> Best regards,<br/> PlusX Electric App Team </p>
        </body>
    </html>`;

    emailQueue.addEmail(data.rider_email, 'PlusX Electric App: Charging Subscription Confirmation', html);
    
    return resp.json({status:1, code:200, message: ["Your PlusX subscription is active! Start booking chargers for your EV now."]});
};

/* Helper function to retrieve Stripe customer ID using the provided email */
export const findCustomerByEmail = async (email) => {
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
    if (!email) return resp.status(400).json({ status: 0, message: ['Email is required.']});
    
    try {
        const customers = await stripe.customers.list({ email });
        if (customers.data.length > 0) {
            return {
                success      : true,
                customer_id  : customers.data[0].id,
                name         : customers.data[0].name
            };
        } else {
            return {success: false, message: 'No customer found with this email'};
        }
    } catch (error) {
        return {success: false, message: error.message};
    }
};

/* Helper to retrive total amount from PCB or CS */
export const getTotalAmountFromService = async (booking_id, booking_type) => {
    let invoiceId, total_amount;

    if(booking_type === 'PCB'){
        const data = await queryDB(`
            SELECT 
                pcb.start_charging_level, pcb.end_charging_level, pcb.user_name AS rider_name,
                (select r.rider_email from riders AS r where r.rider_id = pcb.rider_id limit 1) AS rider_email,
                (SELECT coupan_percentage FROM coupon_usage WHERE booking_id = pcb.booking_id) AS discount,
                (select created_at from portable_charger_history AS bh where bh.booking_id = pcb.booking_id and order_status = 'CS' limit 1) AS charging_start,
                (select created_at from portable_charger_history AS bh where bh.booking_id = pcb.booking_id and order_status = 'CC' limit 1) AS charging_end
            FROM
                portable_charger_booking as pcb
            WHERE 
                booking_id = ? LIMIT 1
        `, [booking_id]);

        if (!data) return { success: false, message: 'No data found for the invoice.' };
        
        const startChargingLevels = data.start_charging_level ? data.start_charging_level.split(',').map(Number) : [0];
        const endChargingLevels = data.end_charging_level ? data.end_charging_level.split(',').map(Number) : [0];
        
        if (startChargingLevels.length !== endChargingLevels.length) return resp.json({ error: 'Mismatch in charging level data.' });

        const chargingLevelSum = startChargingLevels.reduce((sum, startLevel, index) => {
            const endLevel = endChargingLevels[index];
            return sum + Math.max(startLevel - endLevel, 0);
        }, 0);

        let killoWatt  = chargingLevelSum * 0.25;
        if( chargingLevelSum < 1 ) { 
            const date1       = new Date(data.charging_start);
            const date2       = new Date(data.charging_end);
            const momentDate1 = moment(date1); 
            const momentDate2 = moment(date2);
            let hrsConsumed   = ( momentDate2.diff(momentDate1, 'minutes') ) / 60 ;
                killoWatt     = hrsConsumed * 7;
        }
        data.kw           = killoWatt;
        data.kw_dewa_amt  = data.kw * 0.44;
        data.kw_cpo_amt   = data.kw * 0.26;
        data.delv_charge  = 30;
        data.t_vat_amt    = 0.00; //Math.floor((data.kw_dewa_amt + data.kw_cpo_amt + data.delv_charge) * 5) / 100;
        data.total_amt    = 0.00; //data.kw_dewa_amt + data.kw_cpo_amt + data.t_vat_amt;

        total_amount =  (data.total_amt) ? Math.round(data.total_amt) : 0.00;

        return {success: true, total_amount, data, message: 'Pod Amount fetched successfully'};
    }else if(booking_type === 'CS'){
        invoiceId = booking_id.replace('CS', 'INVCS');

        const data = await queryDB(`
            SELECT 
                csi.invoice_id, csi.amount, cs.request_id
            FROM 
                charging_service_invoice AS csi
            LEFT JOIN
                charging_service AS cs ON cs.request_id = csi.request_id
            WHERE 
                csi.invoice_id = ?
            LIMIT 1
        `, [invoiceId]);

        if (!data) return { success: false, message: 'No data found for the invoice.' };

        total_amount = (data.amount) ? data.amount : 0.00;
        return {success: true, total_amount, message: 'PickDrop Amount fetched successfully'};
    }else{
        return {success: false, total_amount,  message: 'Invalid Booking Id'}; 
    }
}
