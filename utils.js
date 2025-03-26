import NodeCache from "node-cache";
import axios from "axios";
import path from 'path';
import puppeteer from 'puppeteer';
import ejs from 'ejs';
import { insertRecord } from "./dbUtils.js";
import { GoogleAuth } from "google-auth-library";
import { fileURLToPath } from 'url';
import fs from 'fs';
import dotenv from 'dotenv';
import db from "./config/db.js";
dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export function mergeParam(req) {
  return { ...req.query, ...req.body };
};

export const generateRandomPassword = (length = 8) => {
  const chars =
    "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let password = "";
  for (let i = 0; i < length; i++) {
    const randomIndex = Math.floor(Math.random() * chars.length);
    password += chars[randomIndex];
  }
  return password;
};

export const checkNumber = (countryCode, num) => {
  const numArr = [
    { code: "+971", startWith: [5], length: 9 },
    // { code: "+973", startWith: [3, 6, 8], length: 8 },
    // { code: "+965", startWith: [5, 6, 9], length: 8 },
    // { code: "+968", startWith: [7], length: 8 },
    // { code: "+966", startWith: [5], length: 9 },
    // { code: "+91", startWith: [6, 7, 8, 9], length: 10 },
    // { code: "+1", startWith: [0, 1, 2, 9], length: 10 },
    // { code: "+44", startWith: [0, 7], length: 11 },
    // { code: "+974", startWith: [3, 5, 6], length: 8 },
  ];

  const entry = numArr.find((item) => item.code === countryCode);

  if (entry) {
    const first = Number(num.charAt(0));
    const isValidStart = entry.startWith.includes(first);
    const isValidLength = num.length === entry.length;

    if (!isValidStart) {
      return { status: 0, msg: `No start with ${entry.startWith.join(", ")}` };
    }
    if (!isValidLength) {
      return { status: 0, msg: `No should be ${entry.length} digits` };
    }
    return { status: 1, msg: "No is valid!" };
  }
  return { status: 0, msg: "The number you entered is not correct. Please provide a valid UAE number." };
};

export const generateOTP = (length) => {
  let result = "";
  for (let i = 0; i < length; i++) {
    result += Math.floor(Math.random() * 10);
  }
  return result;
};

/* Sore & Retrieve OTP from Cache Memory */
const otpCache = new NodeCache({ stdTTL: 240 });
export const storeOTP = (key, otp) => {
  otpCache.set(key, otp);
};

export const getOTP = (key) => {
  return otpCache.get(key);
};

/* API Call to Send OTP */
export const sendOtp = async (mobile, otpMsg) => {
  const username = process.env.SMS_USERNAME;
  const password = process.env.SMS_PASSWORD;
  const from = "PlusX";

  const baseUrl = `https://api.smsglobal.com/http-api.php?action=sendsms&user=${username}&password=${password}&from=${encodeURIComponent(
    from
  )}&to=${mobile}&text=${encodeURIComponent(otpMsg)}`;

  try {
    const response = await axios.get(baseUrl);

    if (response.data) {
      return { status: 1, msg: response.data };
    }
  } catch (err) {
    return { status: 0, msg: err.message, code: err.status };
  }
};


/* Format Timings */
export const getOpenAndCloseTimings = (data) => {
  const dayTime = [];

  if (data.always_open === 0) {
    const openDays = data.open_days.split(',').map(day => day.trim());
    const openTimings = data.open_timing.split(',').map(time => time.trim());
    const uniqueTimings = [...new Set(openTimings)];

    if (uniqueTimings.length !== openTimings.length) {
      uniqueTimings.forEach((timing) => {
        const keys = openTimings.reduce((acc, curr, index) => {
          if (curr === timing) acc.push(index);
          return acc;
        }, []);
        let start = '';
        let end = '';
        let formattedTiming = 'Closed';

        if (timing !== 'Closed') {
          const times = timing.split('-');
          const startTime = formatTime(times[0]);
          const endTime = formatTime(times[1]);
          formattedTiming = `${startTime}-${endTime}`;
        }

        for (let i = 0; i < keys.length; i++) {
          start = (start === '') ? openDays[keys[i]] : start;

          if (keys[i + 1] && (keys[i + 1] - keys[i] !== 1 && i + 1 !== keys.length)) {
            end = openDays[keys[i]];
            const days = start === end ? end : `${start}-${end}`;
            dayTime.push({ days, time: formattedTiming, position: keys[i] });
            start = '';
          }

          if (i + 1 === keys.length) {
            end = openDays[keys[i]];
            const days = start === end ? end : `${start}-${end}`;
            dayTime.push({ days, time: formattedTiming, position: keys[i] });
          }
        }
      });
    }

    dayTime.sort((a, b) => a.position - b.position);

    return dayTime;
  } else {
    return [{ days: 'Always Open', time: '' }];
  }
};
const formatTime = (timeStr) => {
  const [hour, minute, second] = timeStr.split(':').map(Number);
  const isPM = hour >= 12;
  const adjustedHour = hour % 12 === 0 ? 12 : hour % 12;
  const period = isPM ? 'PM' : 'AM';

  return `${adjustedHour.toString().padStart(2, '0')}:${minute.toString().padStart(2, '0')} ${period}`;
};

export const formatOpenAndCloseTimings = (alwaysOpen, data) => {
  if (!alwaysOpen) return { fDays: '', fTiming: '' };

  const fDays = data.days.join('_');

  const timeArr = data.days.map(day => {
      const openTime = data[`${day}_open_time`];
      const closeTime = data[`${day}_close_time`];

      if (openTime && closeTime) {
          const formattedOpenTime = new Date(`1970-01-01T${openTime}`).toTimeString().slice(0, 8);
          const formattedCloseTime = new Date(`1970-01-01T${closeTime}`).toTimeString().slice(0, 8);
          return `${formattedOpenTime}-${formattedCloseTime}`;
      } else {
          return 'Closed';
      }
  });

  const fTiming = timeArr.join('_');

  return { fDays, fTiming };
};

/* convert  time */
export const convertTo24HourFormat = (timeStr) => {
  const [time, modifier] = timeStr.split(' '); 
  let [hours, minutes] = time.split(':');

  hours = String(hours); 

  if (modifier === 'PM' && hours !== '12') {
      hours = (parseInt(hours, 10) + 12).toString(); 
  }

  if (modifier === 'AM' && hours === '12') {
      hours = '00'; // Convert 12 AM to 00 hours
  }

  return `${hours.padStart(2, '0')}:${minutes.padStart(2, '0')}:00`; 
};

/* Amount Number To Word Converter */
export function numberToWords(num) {
  const ones = [
      "ZERO", "ONE", "TWO", "THREE", "FOUR", "FIVE",
      "SIX", "SEVEN", "EIGHT", "NINE", "TEN", "ELEVEN",
      "TWELVE", "THIRTEEN", "FOURTEEN", "FIFTEEN",
      "SIXTEEN", "SEVENTEEN", "EIGHTEEN", "NINETEEN"
  ];

  const tens = [
      "ZERO", "TEN", "TWENTY", "THIRTY", "FORTY",
      "FIFTY", "SIXTY", "SEVENTY", "EIGHTY", "NINETY"
  ];

  const hundreds = [
      "HUNDRED", "THOUSAND", "MILLION", "BILLION", "TRILLION", "QUARDRILLION"
  ];

  num = Number(num).toFixed(2);
  const numParts = num.split(".");
  const wholeNum = numParts[0];
  const decNum = numParts[1];

  const wholeArr = Array.from(wholeNum).reverse().join('').split(/(?=(?:\d{3})+$)/g).reverse();
  let resultText = "";

  for (let key = 0; key < wholeArr.length; key++) {
      let i = wholeArr[key].replace(/^0+/, '');

      if (i.length === 0) continue;

      if (i < 20) {
          resultText += ones[parseInt(i)];
      } else if (i < 100) {
          resultText += tens[Math.floor(i / 10)];
          if (i % 10 > 0) resultText += " " + ones[i % 10];
      } else {
          resultText += ones[Math.floor(i / 100)] + " " + hundreds[0];
          const remainder = i % 100;
          if (remainder > 0) {
              if (remainder < 20) {
                  resultText += " " + ones[remainder];
              } else {
                  resultText += " " + tens[Math.floor(remainder / 10)];
                  if (remainder % 10 > 0) resultText += " " + ones[remainder % 10];
              }
          }
      }

      if (key > 0) {
          resultText += " " + hundreds[key] + " ";
      }
  }

  if (decNum > 0) {
      resultText += " UAE Dirhams and ";
      if (decNum < 20) {
          resultText += ones[parseInt(decNum)];
      } else {
          resultText += tens[Math.floor(decNum / 10)];
          if (decNum % 10 > 0) resultText += " " + ones[decNum % 10];
      }
      resultText += " Fils Only";
  } else {
      resultText += " UAE Dirhams Only";
  }

  return resultText.replace("Uae", "UAE").toLowerCase().replace(/\b\w/g, c => c.toUpperCase());
}

/* Format Number */
export function formatNumber(value) {
  return new Intl.NumberFormat('en-US', { 
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
  }).format(value);
};

/* Create Notification */
export const createNotification = async (heading, desc, module_name, panel_to, panel_from, created_by, receive_id, href_url='') => {
  const result = await insertRecord('notifications', [
    'heading', 'description', 'module_name', 'panel_to', 'panel_from', 'created_by', 'receive_id', 'status', 'href_url'
  ],[
    heading, desc, module_name, panel_to, panel_from, created_by, receive_id, '0', href_url
  ]);

  return {
    affectedRows: result.affectedRows
  };
};

/* Send Notification */
const getAccessToken = async (fcmType) => {
  try {
    const fileName = (fcmType === 'RSAFCM') ? 'plusx-support-firebase.json' : 'plusx-electric-firebase.json';
    const serviceAccountPath = path.join(__dirname, 'public/firebase-files/', fileName);

    const auth = new GoogleAuth({
        keyFilename: serviceAccountPath,
        scopes: ['https://www.googleapis.com/auth/firebase.messaging'],
    });
    const client = await auth.getClient();
    const accessTokenResponse = await client.getAccessToken();
    const accessToken = accessTokenResponse.token;

    return accessToken;
} catch (error) {
    console.error('Error fetching access token:', error.message);
    throw error;
}
};

export const pushNotification = async ( deviceToken, title, body, fcmType, clickAction ) => {
    try {
        const accessToken      = await getAccessToken(fcmType);
        const clickActionParts = clickAction.split("/");
        
        const notification = {
          title: title,
          body: body,
        };
        const data = {
          title: title,
          body: body,
          click_action: clickActionParts[0],
          refrence_id: clickActionParts[1],
        };
        
        const message = {
          message: {
            token: deviceToken,
            notification: notification,
            data: data,
            apns: {
              payload: {
                aps: {
                  sound: "default",
                },
              },
            },
            android: {
              priority: "high",
              // notification: {
              //   click_action: clickActionParts[0],
              // },
            },
          },
        };        

        const projectId = (fcmType === 'RSAFCM') ? 'plusx-support' : 'plusx-electric-27f64';
        const url       = `https://fcm.googleapis.com/v1/projects/${projectId}/messages:send`;
        const response  = await axios.post(url, message, {
          headers: {
            'Authorization': `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
          },
        });
        // console.log('Notification sent successfully:', message);
    } catch (error) {
        console.error('Error sending notification:', error.response ? error.response.data : error.message);
    }
};

/* Fromat Date Time in Sql Query */
export const formatDateTimeInQuery = (columns) => {
  return columns.map(column => {
      if (column.includes('.')) {
        const alias = column.split('.').pop();
        return `DATE_FORMAT(CONVERT_TZ(${column}, 'UTC', 'Asia/Dubai'), '%Y-%m-%d %H:%i:%s') AS ${alias}`;
      } else {
        return `DATE_FORMAT(CONVERT_TZ(${column}, 'UTC', 'Asia/Dubai'), '%Y-%m-%d %H:%i:%s') AS ${column}`;
      }
  }).join(', ');
};

export const formatDateInQuery = (columns) => {
  return columns.map(column => {
      if (column.includes('.')) {
        const alias = column.split('.').pop();
        return `DATE_FORMAT(CONVERT_TZ(${column}, 'UTC', 'Asia/Dubai'), '%Y-%m-%d') AS ${alias}`;
      } else {
        return `DATE_FORMAT(CONVERT_TZ(${column}, 'UTC', 'Asia/Dubai'), '%Y-%m-%d') AS ${column}`;
      }
  }).join(', ');
};

/* Helper to delete a image from uploads/ */
export const deleteFile = (directory, filename) => {
  const file_path = path.join('uploads', directory, filename);
  if(file_path){
    fs.unlink(file_path, (err) => {
        if (err) console.error(`Failed to delete ${directory} image ${filename}:`, err);
    });
  }else{
    console.log('File does not exist.');
  }
};

export const asyncHandler = (fn) => {
  return function (req, res, next) {
      fn(req, res, next).catch(next);
  };
};

/* Generates a PDF from an EJS template. - M1 Not supported using puppeter */

export const generatePdf = async (templatePath, invoiceData, fileName, savePdfDir, req) => {
  try {
    const html = await ejs.renderFile(templatePath, { ...invoiceData });
    // const serverUrl = `https://plusx.shunyaekai.com/web/upload-pdf`;
    const serverUrl = `${req.protocol}://${req.get('host')}/web/upload-pdf`;       
    
    const response = await axios.post('http://supro.shunyaekai.tech:8801/pdf-api.php', {  //http://supro.shunyaekai.tech:8801/pdf-api.php
      html,
      fileName,
      serverUrl,
      savePdfDir
    }, { 
      headers: { 'Content-Type': 'application/json' }
    });
    
    if (response.data.success) {
      console.log('PDF generated successfully:');
      return { success: true , pdfPath: response.data.php_response.pdfPath} ;
    }
  } catch (error) {
    console.error('Error generating PDF _from_utils:', error);
    return { success: false, error };
  }
};