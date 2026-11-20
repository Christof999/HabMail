import { nurHabMail } from './_vercel.js'
import sendMail from '../server/send-mail.js'

export default nurHabMail(sendMail)
