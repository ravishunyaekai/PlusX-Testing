
import path from 'path';
import { fileURLToPath } from 'url';
import transporter from '../mailer.js';
import fs from "fs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

import mysql from "mysql2";
import emailQueue from "../emailQueue.js";

import { queryDB } from '../dbUtils.js';
import moment from "moment-timezone";

import Stripe from "stripe";
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
import validateFields from "../validation.js";

// Create a MySQL connection
const connection = mysql.createConnection({
    host     : "plus-x.cue7elc3bjnz.ap-south-1.rds.amazonaws.com", // Change if your DB is on another server
    user     : "master",
    password : "nZ0rKy2iT8KgiS0oo5",
    database : "plusx-node"
});
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

export const bulkEmailSend = async (req, resp) => {
    return resp.json({ message : 'Not working' });
    
    const htmlFilePath = path.join(__dirname, "PlusXEmailer.html");
    const emailHtml = fs.readFileSync(htmlFilePath, "utf8");
    try { 
       
        const recipients = connection.query("SELECT rider_email FROM riders group by rider_email limit 500, 600", async (err, results) => {
            if (err) {
                // console.error("Query failed: " + err.message);
                return resp.json({
                    Users  : err.message,
                });
            } else {
                // console.log("Users:", results);
                // return results.map(row => row.rider_email) ;
                
                const recipients = results.map(row => row.rider_email); // ["ravi@shunyaekai.tech", "aarti@shunyaekai.tech"]; //
                
                for (let email of recipients) {
                
                    emailQueue.addEmail(email, 'PlusX Electric Early Bird Offer: Charge Your EV for Just AED 30!', emailHtml);
                    // await transporter.sendMail({
                    //     from    : `"PlusX Electric" <media@plusxelectric.com>`,
                    //     to      :  email,
                    //     subject : 'PlusX Electric Early Bird Offer: Charge Your EV for Just AED 30!',
                    //     html    : emailHtml
                    // });
                    // await delay(1000); 
                }
                return resp.json({
                    message  : recipients,
                });
            }
        });
        
    } catch(err) {
        console.log('Error in sending mail', err);
        return resp.json({
            message  : err,
        });
        
    }
};


export const GetInvoiceByHRS = async (req, resp) => {
    const booking_id = 'PCB0095';
    let total_amount;
    
    try { 
       
        const data = await queryDB(`
            SELECT 
                pcb.start_charging_level, pcb.end_charging_level, 
                (select created_at from portable_charger_history AS bh where bh.booking_id = pcb.booking_id and order_status = 'CS' limit 1) AS charging_start,
                (select created_at from portable_charger_history AS bh where bh.booking_id = pcb.booking_id and order_status = 'CC' limit 1) AS charging_end
            FROM
                portable_charger_booking as pcb
            WHERE 
                pcb.booking_id = ? LIMIT 1
        `, [booking_id]);

        if (!data) return resp.json( { success: false, message: 'No data found for the invoice.' } );
        
        const startChargingLevels = data.start_charging_level ? data.start_charging_level.split(',').map(Number) : [0];
        const endChargingLevels = data.end_charging_level ? data.end_charging_level.split(',').map(Number) : [0];
        
        if (startChargingLevels.length !== endChargingLevels.length) return resp.json({ error: 'Mismatch in charging level data.' });

        const chargingLevelSum = startChargingLevels.reduce((sum, startLevel, index) => {
            const endLevel = endChargingLevels[index];
            return sum + Math.max(startLevel - endLevel, 0);
        }, 0);

        let killoWatt  = chargingLevelSum * 0.25;
        console.log('chargingLevelSum', chargingLevelSum);
        if(chargingLevelSum == 0) { 
            const date1 = new Date(data.charging_start);
            const date2 = new Date(data.charging_end);

            const momentDate1 = moment(date1); 
            const momentDate2 = moment(date2);

            let hrsConsumed = ( momentDate2.diff(momentDate1, 'minutes') ) / 60 ;

            console.log('hrsConsumed', hrsConsumed);
                killoWatt   = hrsConsumed * 7;
        }
        console.log('killoWatt', killoWatt);
        data.kw           = killoWatt;
        data.kw_dewa_amt  = data.kw * 0.44;
        data.kw_cpo_amt   = data.kw * 0.26;
        data.delv_charge  = 30;
        data.t_vat_amt    = Math.floor((data.kw_dewa_amt + data.kw_cpo_amt + data.delv_charge) * 5) / 100;
        data.total_amt    = data.kw_dewa_amt + data.kw_cpo_amt + data.delv_charge + data.t_vat_amt;

        total_amount = (data.total_amt) ? Math.round(data.total_amt) : 0.00;

        return resp.json({ success: true, total_amount, data, message: 'Pod Amount fetched successfully'} );
        
    } catch(err) {
        console.log('Error in sending mail', err);
        return resp.json({
            message  : err,
        });
        
    }
};

export const getPaymentSession = async (req, resp) => {
    
    const {rider_name, amount, currency, booking_id, building_name, street_name='', unit_no, area, emirate, screen } = mergeParam(req);

    const { isValid, errors } = validateFields(req.body, {
        rider_name  : ["required"], 
        amount      : ["required"],
        currency    : ["required"],
        booking_id    : ["required"],
        building_name : ["required"],
        unit_no       : ["required"],
        area          : ["required"],
        emirate       : ["required"],
        screen        : ["required"],
    });
    try {
        const session = await stripe.checkout.sessions.create({
            payment_method_types: ["card"],
            line_items : [
                {
                    price_data : {
                        currency     : currency,
                        product_data : { name: `This booking Id : ${booking_id} for POD Booking.` },
                        unit_amount  : amount, // $50.00
                    },
                    quantity : 1,
                },
            ],
            payment_method_options: {
                card : {
                  request_three_d_secure: "any", // Force OTP for every transaction
                },
            },
            customer_creation   : "always",
            payment_intent_data : {
                shipping: {
                    name    : rider_name,
                    address : {
                        line1       : `${building_name} ${street_name}`, //"D55-PBU - Dubai Production City",
                        city        : area,         //"Dubai Production City",
                        state       : emirate,     //"Dubai",
                        country     : "United Arab Emirates",   // ✅ Default country set to the United States
                        postal_code : unit_no,   //"D55",
                    },
                },
            },
            default_values : {
                billing_address : {
                    country : "AE", // Default Country Set to UAE
                }, 
            },
            payment_intent_data: {
                setup_future_usage: "off_session", // Forces 3D Secure authentication
            },
            mode        : "payment",
            success_url : `https://plusx.shunyaekai.com/payment-success`,   //?booking_id=${booking_id}&screen=${screen}&session_id=${session.id} 
            cancel_url  : `https://plusx.shunyaekai.com/payment-cancel`    //?screen=${screen}
            // automatic_payment_methods : { enabled: true },
        });
        // resp.json({ url: session.url });
        return resp.json({ message: ['Paymnet session'], status: 1, code: 200,  url: session.url, session_id: session.id });
    } catch (error) {
        // resp.status(500).json({ error: error.message });
        return resp.json({ message: ['Sorry this is a duplicate entry!'], status: 0, code: 200, error : error.message });
    }
} 
export const getPaymentSessionData = async (req, resp) => {
    
    const sessionId = 'cs_live_a1Oz0aOfjntoOzM4PkovHjrOiFuc2E0nkFP0g3sLVSyezgrYbM9wmCv2sJ' ;
    const payment_intent_id = 'pi_3R7A3JKKO9oLX4Mk0MtqAdf3'
    try {
        // const session = await stripe.checkout.sessions.retrieve(sessionId);
        // console.log("Checkout Session:", session);
        
        const paymentIntent = await stripe.paymentIntents.retrieve(payment_intent_id);
        const session       = await stripe.charges.retrieve(paymentIntent.latest_charge);        
        
        return resp.json({ session });
    } catch (error) {
        return resp.json({ error : error.message });
    }
}
// app.listen(3000, () => console.log("Server running on port 3000"));
// payment_status, amount_total, id, created, customer, payment_intent, currency, status
// 


